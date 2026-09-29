"""测试：床位竞争、清洁阻断、配件数量、押金幂等、病区权限。

直接使用独立临时数据库，不经过 HTTP；并发竞争用多线程模拟两名护士。
运行：python3 -m unittest discover -s tests -v
"""
from __future__ import annotations

import tempfile
import threading
import unittest
from datetime import datetime, timedelta
from pathlib import Path

from app.db import connect, init_db
from app.deposit import DepositError
from app.seed import seed_all
from app.services import Service, ServiceError


def _today(offset_days=0, hour=12):
    d = datetime.now().replace(minute=0, second=0, microsecond=0)
    return d + timedelta(days=offset_days, hours=hour - d.hour)


class ServiceTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.conn = connect(root / "test.db")
        seed_all(self.conn, root / "photos", reset=True)
        self.svc = Service(self.conn, root / "photos")

        def ids(table, where="1=1"):
            return {r[1]: r[0] for r in self.conn.execute(
                f"SELECT id, code FROM {table} WHERE {where}")}

        self.ward = ids("wards")                 # N3 / S2 / P1
        self.bed = ids("beds")
        self.nurse = {}
        for r in self.conn.execute("SELECT id, name FROM nurses"):
            self.nurse[r[1]] = r[0]
        # 待处理申请 R-Q001（N3 标准床），可用清洁空闲床 N3-03? 不——N3-03 加宽。
        # 空闲清洁标准床：N3-02（seed 中已 clean 空闲）。
        self.req_q001 = self.conn.execute(
            "SELECT id FROM requests WHERE code='R-Q001'").fetchone()[0]

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    # 1) 床位竞争：两名护士同时分配同一床位，只允许一人成功 ----------------
    def test_bed_race_only_one_wins(self):
        bed_id = self.bed["N3-02"]
        # 需要两个不同的待处理 N3 申请争抢同一张床
        req2 = self.svc.create_request(
            self._applicant("P-1002"), self.ward["N3"], "标准床",
            str(_today(0, 14)), str(_today(2, 10)), "竞争测试")
        n1, n2 = self.nurse["周护士"], self.nurse["吴护士"]
        results = {}
        barrier = threading.Barrier(2)

        def assign(which, req_id):
            try:
                barrier.wait(timeout=5)
                self.svc.assign(req_id, bed_id, n1 if which == 0 else n2)
                results[which] = "ok"
            except ServiceError as e:
                results[which] = e.code

        t1 = threading.Thread(target=assign, args=(0, self.req_q001))
        t2 = threading.Thread(target=assign, args=(1, req2))
        t1.start(); t2.start(); t1.join(); t2.join()

        self.assertEqual(sorted(results.values()), ["bed_race", "ok"])
        active = self.conn.execute(
            "SELECT COUNT(*) FROM assignments WHERE bed_id=? AND status='active'",
            (bed_id,)).fetchone()[0]
        self.assertEqual(active, 1, "同一床位出现两个有效订单")

    # 2) 清洁阻断 + 维修阻断 + 隔离阻断 ------------------------------------
    def test_cleaning_and_maintenance_block(self):
        n = self.nurse["周护士"]
        # dirty：N3-04
        with self.assertRaises(ServiceError) as cm:
            self.svc.assign(self.req_q001, self.bed["N3-04"], n)
        self.assertEqual(cm.exception.code, "bed_dirty")
        # maintenance：N3-05（加宽，用 R-Q002）
        req_q002 = self.conn.execute(
            "SELECT id FROM requests WHERE code='R-Q002'").fetchone()[0]
        with self.assertRaises(ServiceError) as cm:
            self.svc.assign(req_q002, self.bed["N3-05"], n)
        self.assertEqual(cm.exception.code, "bed_maintenance")

        # 污染隔离床 S2-03 不得预约
        req_s2 = self.svc.create_request(
            self._applicant("P-1003"), self.ward["S2"], "标准床",
            str(_today(0, 18)), str(_today(1, 12)))
        with self.assertRaises(ServiceError) as cm:
            self.svc.assign(req_s2, self.bed["S2-03"], self.nurse["郑护士"])
        self.assertEqual(cm.exception.code, "bed_isolated")

        # 归还后床变 dirty；消毒失败仍阻断；消毒合格后才可再约
        res = self.svc.assign(self.req_q001, self.bed["N3-02"], n)
        aid = res["assignment_id"]
        items = self._ok_items(aid)
        self.svc.return_bed(aid, n, items)
        with self.assertRaises(ServiceError) as cm:
            self.svc.assign(
                self.svc.create_request(
                    self._applicant("P-1004"), self.ward["N3"], "标准床",
                    str(_today(0, 20)), str(_today(2))),
                self.bed["N3-02"], n)
        self.assertEqual(cm.exception.code, "bed_dirty")

        batch = self.svc.create_batch(self.bed["N3-02"], n, "消毒员")
        self.svc.finish_batch(batch["batch_id"], False, "消毒失败")
        with self.assertRaises(ServiceError) as cm:
            self.svc.assign(
                self.svc.create_request(
                    self._applicant("P-1005"), self.ward["N3"], "标准床",
                    str(_today(0, 21)), str(_today(2))),
                self.bed["N3-02"], n)
        self.assertEqual(cm.exception.code, "bed_dirty")

        batch2 = self.svc.create_batch(self.bed["N3-02"], n, "消毒员")
        self.svc.finish_batch(batch2["batch_id"], True)
        # 合格后重新可约（不抛异常）
        ok = self.svc.assign(
            self.svc.create_request(
                self._applicant("P-1006"), self.ward["N3"], "标准床",
                str(_today(0, 22)), str(_today(2))),
            self.bed["N3-02"], n)
        self.assertIn("assignment_id", ok)

    # 3) 配件数量：缺失、超额、原因、污染列汇总 -----------------------------
    def test_accessory_quantity(self):
        n = self.nurse["周护士"]
        res = self.svc.assign(self.req_q001, self.bed["N3-02"], n)
        aid = res["assignment_id"]

        # 归还数量超过应发数量（脚轮锁应发 4，还 5）必须拒绝
        items = self.conn.execute(
            "SELECT * FROM bed_items WHERE assignment_id=?", (aid,)).fetchall()
        too_many = {str(it["id"]): {
            "qty_returned": it["qty_expected"] + 1,
            "condition": "ok", "reason": ""} for it in items}
        with self.assertRaises(ServiceError) as cm:
            self.svc.return_bed(aid, n, too_many)
        self.assertEqual(cm.exception.code, "qty_exceeded")

        # 呼叫器缺 1、脚轮锁缺 2，配件列应为 missing 且带原因
        normal = {str(it["id"]): {
            "qty_returned": it["qty_expected"], "condition": "ok", "reason": ""}
            for it in items}
        caller = next(it for it in items if it["item_name"] == "呼叫器")
        wheels = next(it for it in items if it["item_name"] == "脚轮锁")
        normal[str(caller["id"])] = {"qty_returned": 0, "condition": "missing",
                                     "reason": "遗落家中"}
        normal[str(wheels["id"])] = {"qty_returned": 2, "condition": "missing",
                                     "reason": "脚轮损坏拆除"}
        out = self.svc.return_bed(aid, n, normal)
        self.assertEqual(out["columns"]["accessory"]["status"], "missing")
        self.assertIn("呼叫器", out["columns"]["accessory"]["reason"])
        self.assertEqual(out["bed_cleaning"], "dirty")

        # 床品缺失应登记异常事件
        ex = [r["type"] for r in self.conn.execute(
            "SELECT type FROM exceptions WHERE ref_id=?", (aid,))]
        self.assertIn("linen_missing", ex)

    def test_contaminated_sets_isolation(self):
        n = self.nurse["郑护士"]
        req = self.svc.create_request(
            self._applicant("P-1007"), self.ward["S2"], "标准床",
            str(_today(0, 10)), str(_today(1)))
        res = self.svc.assign(req, self.bed["S2-04"], n)
        aid = res["assignment_id"]
        items = self._ok_items(aid)
        sheet = next((k for k, v in items.items()
                      if self.conn.execute(
                          "SELECT item_name FROM bed_items WHERE id=?",
                          (k,)).fetchone()[0] == "床单"), None)
        items[sheet] = {"qty_returned": 1, "condition": "contaminated",
                        "reason": "可见体液污染"}
        out = self.svc.return_bed(aid, n, items)
        self.assertEqual(out["bed_cleaning"], "isolated")
        self.assertEqual(out["columns"]["linen"]["status"], "contaminated")

    # 4) 押金幂等：相同幂等键重试只入账一次；结算锁定 -----------------------
    def test_deposit_idempotency(self):
        n = self.nurse["周护士"]
        res = self.svc.assign(self.req_q001, self.bed["N3-02"], n,
                              idempotency_key="hold-key-1")
        aid = res["assignment_id"]
        # 同键重复 hold：只入账一次
        first = self.svc.deposits.hold(aid, 30000, "hold-key-1")
        self.assertFalse(first, "重复幂等键应当返回 False")
        hold_rows = self.conn.execute(
            "SELECT COUNT(*) FROM deposit_ledger "
            "WHERE assignment_id=? AND action='hold'", (aid,)).fetchone()[0]
        self.assertEqual(hold_rows, 1)
        summary = self.svc.deposits.summary(aid)
        self.assertEqual(summary["hold"], 30000)

        # 扣减同键重试也只一次
        self.assertTrue(self.svc.deposits.deduct(aid, 5000, "ded-1", "缺失"))
        self.assertFalse(self.svc.deposits.deduct(aid, 5000, "ded-1", "缺失"))
        self.assertEqual(self.svc.deposits.summary(aid)["deducted"], 5000)

        # 多线程同键退款：总退款不超过一次
        barrier = threading.Barrier(3)
        wins = []
        wlock = threading.Lock()

        def refund():
            barrier.wait(timeout=5)
            try:
                ok = self.svc.deposits.refund(aid, 25000, "refund-1")
                with wlock:
                    wins.append(ok)
            except DepositError:
                with wlock:
                    wins.append(False)

        ts = [threading.Thread(target=refund) for _ in range(3)]
        for t in ts: t.start()
        for t in ts: t.join()
        self.assertEqual(sum(1 for x in wins if x), 1)
        self.assertEqual(self.svc.deposits.summary(aid)["refunded"], 25000)

        # 归还并结算后，迟到归还不能重开订单
        self.svc.return_bed(aid, n, self._ok_items(aid))
        self.svc.settle(aid)
        with self.assertRaises(ServiceError) as cm:
            self.svc.return_bed(aid, n, self._ok_items(aid))
        self.assertEqual(cm.exception.code, "order_locked")
        with self.assertRaises(ServiceError) as cm:
            self.svc.settle(aid)
        self.assertEqual(cm.exception.code, "already_settled")

    # 5) 病区权限：跨病区分配/归还/消毒/调拨均被拒绝 ------------------------
    def test_ward_permission(self):
        zhou_n3 = self.nurse["周护士"]
        zheng_s2 = self.nurse["郑护士"]
        feng_p1 = self.nurse["冯护士"]

        # N3 护士不能确认 S2 的申请
        req_s2 = self.conn.execute(
            "SELECT id FROM requests WHERE code='R-Q003'").fetchone()[0]
        with self.assertRaises(ServiceError) as cm:
            self.svc.assign(req_s2, self.bed["S2-04"], zhou_n3)
        self.assertEqual(cm.exception.code, "ward_forbidden")

        # 正确归属可分配
        res = self.svc.assign(req_s2, self.bed["S2-04"], zheng_s2)
        aid = res["assignment_id"]

        # N3 护士不能核验 S2 订单
        with self.assertRaises(ServiceError) as cm:
            self.svc.return_bed(aid, zhou_n3, self._ok_items(aid))
        self.assertEqual(cm.exception.code, "ward_forbidden")
        self.svc.return_bed(aid, zheng_s2, self._ok_items(aid))

        # N3 护士不能给 S2 床位开消毒批次
        with self.assertRaises(ServiceError) as cm:
            self.svc.create_batch(self.bed["S2-04"], zhou_n3, "消毒员")
        self.assertEqual(cm.exception.code, "ward_forbidden")

        # 调拨只能由调出病区发起：P1 护士可发起 P1→S2，N3 护士不可
        with self.assertRaises(ServiceError) as cm:
            self.svc.transfer(self.ward["P1"], self.ward["S2"], 1,
                              "冯护士/郑护士", zhou_n3)
        self.assertEqual(cm.exception.code, "ward_forbidden")
        # 无责任人拒绝
        with self.assertRaises(ServiceError) as cm:
            self.svc.transfer(self.ward["P1"], self.ward["S2"], 1,
                              "  ", feng_p1)
        self.assertEqual(cm.exception.code, "no_responsible")
        moved = self.svc.transfer(self.ward["P1"], self.ward["S2"], 1,
                                  "冯护士/郑护士", feng_p1)
        self.assertEqual(len(moved["moved"]), 1)
        moved_bed = self.conn.execute(
            "SELECT ward_id FROM beds WHERE code=?",
            (moved["moved"][0],)).fetchone()[0]
        self.assertEqual(moved_bed, self.ward["S2"])

        # 数量超出可用库存拒绝
        with self.assertRaises(ServiceError) as cm:
            self.svc.transfer(self.ward["P1"], self.ward["N3"], 99,
                              "冯护士/周护士", feng_p1)
        self.assertEqual(cm.exception.code, "qty_unavailable")

    # -- 辅助 --------------------------------------------------------------

    def _applicant(self, code):
        return self.conn.execute(
            "SELECT id FROM applicants WHERE code=?", (code,)).fetchone()[0]

    def _ok_items(self, assignment_id):
        return {str(it["id"]): {
            "qty_returned": it["qty_expected"],
            "condition": "ok", "reason": ""}
            for it in self.conn.execute(
                "SELECT * FROM bed_items WHERE assignment_id=?",
                (assignment_id,)).fetchall()}


if __name__ == "__main__":
    unittest.main()
