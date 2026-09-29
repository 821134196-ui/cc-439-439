"""领域服务层：分配、归还、消毒、维修、换床、调拨、押金结算的业务规则。

关键规则：
* 仅 cleaning_status='clean' 且 maintenance='ok' 且无 active 订单的床可分配；
* 部分唯一索引 idx_active_bed 保证并发分配同一床位只有一人成功；
* 护士只能在本病区操作；
* 归还后床进入 dirty/isolated，必须有合格消毒批次才能重新 clean；
* 已结算订单锁定，迟到归还不能重开。
"""
from __future__ import annotations

import base64
import sqlite3
import threading
import uuid
from datetime import datetime
from pathlib import Path

from .deposit import DepositError, InMemoryDepositAdapter

# 默认押金（分）：标准 300 元，加宽 400 元
DEPOSIT_BY_SPEC = {"标准床": 30000, "加宽床": 40000}
# 固定四列（中文展示名）
CATEGORIES = [
    ("frame", "床架"),
    ("mattress", "床垫"),
    ("linen", "床品"),
    ("accessory", "配件"),
]
# 随床标准清单
STANDARD_KIT = [
    ("frame", "折叠床架", 1),
    ("mattress", "海绵床垫", 1),
    ("linen", "床单", 1),
    ("linen", "被罩", 1),
    ("linen", "枕套", 1),
    ("accessory", "呼叫器", 1),
    ("accessory", "脚轮锁", 4),
]


class ServiceError(Exception):
    def __init__(self, message: str, code: str = "error"):
        super().__init__(message)
        self.code = code


class Service:
    def __init__(self, conn: sqlite3.Connection, photos_dir: str | Path):
        self.conn = conn
        self.photos_dir = Path(photos_dir)
        self.photos_dir.mkdir(parents=True, exist_ok=True)
        self.deposits = InMemoryDepositAdapter(conn)
        # 分配串行点 + 数据库唯一索引双保险
        self._alloc_lock = threading.Lock()

    # -- 工具 --------------------------------------------------------------

    def _now(self) -> str:
        return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    @staticmethod
    def _nonce(n: int = 6) -> str:
        return uuid.uuid4().hex[:n]

    def _exception(self, etype: str, note: str,
                   ref_type: str = "", ref_id: int | None = None,
                   ward_id: int | None = None) -> None:
        self.conn.execute(
            "INSERT INTO exceptions(type, ref_type, ref_id, ward_id, note, created_at)"
            " VALUES(?,?,?,?,?,?)",
            (etype, ref_type, ref_id, ward_id, note, self._now()),
        )

    def _nurse(self, nurse_id: int) -> sqlite3.Row:
        row = self.conn.execute(
            "SELECT * FROM nurses WHERE id=?", (nurse_id,)
        ).fetchone()
        if row is None:
            raise ServiceError("护士不存在", "nurse_missing")
        return row

    def _check_ward(self, nurse_id: int, ward_id: int, action: str) -> None:
        nurse = self._nurse(nurse_id)
        if nurse["ward_id"] != ward_id:
            w = self.conn.execute("SELECT name FROM wards WHERE id=?",
                                  (ward_id,)).fetchone()
            raise ServiceError(
                f"{nurse['name']} 不属于{w['name'] if w else '该病区'}，"
                f"无权执行“{action}”",
                "ward_forbidden",
            )

    # -- 查询 --------------------------------------------------------------

    def bed_map(self) -> list[dict]:
        wards = self.conn.execute("SELECT * FROM wards ORDER BY id").fetchall()
        out = []
        for w in wards:
            beds = self.conn.execute(
                "SELECT b.*, "
                "EXISTS(SELECT 1 FROM assignments a "
                "  WHERE a.bed_id=b.id AND a.status='active') AS occupied "
                "FROM beds b WHERE b.ward_id=? ORDER BY b.code",
                (w["id"],),
            ).fetchall()
            out.append({
                "id": w["id"], "code": w["code"], "name": w["name"],
                "beds": [dict(b) for b in beds],
            })
        return out

    def request_queue(self) -> list[dict]:
        rows = self.conn.execute(
            "SELECT r.*, a.patient_tag, a.relation, w.name AS ward_name "
            "FROM requests r "
            "JOIN applicants a ON a.id=r.applicant_id "
            "JOIN wards w ON w.id=r.ward_id "
            "WHERE r.status='queued' ORDER BY r.id"
        ).fetchall()
        return [dict(r) for r in rows]

    def timeline(self) -> list[dict]:
        rows = self.conn.execute(
            "SELECT asg.*, b.code AS bed_code, b.spec, w.name AS ward_name, "
            "a.patient_tag, n.name AS nurse_name "
            "FROM assignments asg "
            "JOIN beds b ON b.id=asg.bed_id "
            "JOIN wards w ON w.id=asg.ward_id "
            "JOIN requests r ON r.id=asg.request_id "
            "JOIN applicants a ON a.id=r.applicant_id "
            "JOIN nurses n ON n.id=asg.nurse_id "
            "ORDER BY asg.id DESC"
        ).fetchall()
        result = []
        for asg in rows:
            d = dict(asg)
            d["deposit"] = self.deposits.summary(asg["id"])
            ret = self.conn.execute(
                "SELECT * FROM returns WHERE assignment_id=?", (asg["id"],)
            ).fetchone()
            d["return"] = dict(ret) if ret else None
            result.append(d)
        return result

    def batches(self) -> list[dict]:
        rows = self.conn.execute(
            "SELECT bt.*, b.code AS bed_code, w.name AS ward_name "
            "FROM batches bt LEFT JOIN beds b ON b.id=bt.bed_id "
            "JOIN wards w ON w.id=bt.ward_id ORDER BY bt.id DESC"
        ).fetchall()
        return [dict(r) for r in rows]

    def exceptions(self) -> list[dict]:
        rows = self.conn.execute(
            "SELECT e.*, w.name AS ward_name FROM exceptions e "
            "LEFT JOIN wards w ON w.id=e.ward_id ORDER BY e.id DESC"
        ).fetchall()
        return [dict(r) for r in rows]

    def transfers(self) -> list[dict]:
        rows = self.conn.execute(
            "SELECT t.*, w1.name AS from_ward_name, w2.name AS to_ward_name "
            "FROM transfers t "
            "JOIN wards w1 ON w1.id=t.from_ward_id "
            "JOIN wards w2 ON w2.id=t.to_ward_id ORDER BY t.id DESC"
        ).fetchall()
        return [dict(r) for r in rows]

    # -- 分配 --------------------------------------------------------------

    def assign(self, request_id: int, bed_id: int, nurse_id: int,
               idempotency_key: str | None = None) -> dict:
        """确认申请并锁定时段。任一阻断条件不满足都抛 ServiceError。"""
        with self._alloc_lock:
            try:
                self.conn.execute("BEGIN IMMEDIATE")
                req = self.conn.execute(
                    "SELECT * FROM requests WHERE id=?", (request_id,)
                ).fetchone()
                if req is None:
                    raise ServiceError("申请不存在", "request_missing")
                if req["status"] != "queued":
                    raise ServiceError(
                        f"申请已{self._req_status_text(req['status'])}，不能重复确认",
                        "request_not_queued")
                bed = self.conn.execute(
                    "SELECT * FROM beds WHERE id=?", (bed_id,)
                ).fetchone()
                if bed is None:
                    raise ServiceError("床位不存在", "bed_missing")

                # 病区权限：护士、申请、床位必须同病区
                self._check_ward(nurse_id, req["ward_id"], "分配床位")
                if bed["ward_id"] != req["ward_id"]:
                    raise ServiceError("床位与申请不在同一病区", "ward_mismatch")

                # 清洁阻断 / 维修阻断
                if bed["maintenance"] == "maintenance":
                    raise ServiceError(
                        f"{bed['code']} 维修中，不得预约", "bed_maintenance")
                if bed["cleaning_status"] == "dirty":
                    raise ServiceError(
                        f"{bed['code']} 待清洁消毒，暂不可分配", "bed_dirty")
                if bed["cleaning_status"] == "isolated":
                    raise ServiceError(
                        f"{bed['code']} 污染隔离中，不得预约", "bed_isolated")
                if bed["spec"] != req["spec"]:
                    raise ServiceError(
                        f"{bed['code']} 规格为{bed['spec']}，与申请{req['spec']}不符",
                        "spec_mismatch")

                code = f"O-{datetime.now().strftime('%Y%m%d')}-{req['code']}"
                now = self._now()
                cur = self.conn.execute(
                    "INSERT INTO assignments"
                    "(code, request_id, bed_id, ward_id, nurse_id, start_at,"
                    " planned_end_at, status, created_at)"
                    " VALUES(?,?,?,?,?,?,?, 'active', ?)",
                    (code, req["id"], bed["id"], req["ward_id"], nurse_id,
                     req["expected_start"], req["expected_end"], now),
                )
                asg_id = cur.lastrowid

                # 标准清单
                for cat, name, qty in STANDARD_KIT:
                    self.conn.execute(
                        "INSERT INTO bed_items"
                        "(assignment_id, category, item_name, qty_expected,"
                        " qty_returned, condition) VALUES(?,?,?,?,0,'ok')",
                        (asg_id, cat, name, qty),
                    )

                self.conn.execute(
                    "UPDATE requests SET status='assigned' WHERE id=?",
                    (req["id"],),
                )

                # 押金冻结（幂等）
                amount = DEPOSIT_BY_SPEC[req["spec"]]
                key = idempotency_key or f"hold-{asg_id}"
                self.deposits.hold(asg_id, amount, key)
                self.conn.commit()
                return {"assignment_id": asg_id, "code": code,
                        "deposit_fen": amount}
            except ServiceError:
                self.conn.rollback()
                raise
            except sqlite3.IntegrityError as e:
                # 并发竞争：唯一索引拒绝后来者
                self.conn.rollback()
                raise ServiceError(
                    f"床位已被另一名护士先行分配（竞争失败）：{e}",
                    "bed_race") from e
            except DepositError as e:
                self.conn.rollback()
                raise ServiceError(str(e), "deposit_error") from e
            except Exception:
                self.conn.rollback()
                raise

    def _req_status_text(self, s: str) -> str:
        return {"assigned": "确认", "rejected": "驳回",
                "cancelled": "取消"}.get(s, s)

    # -- 归还核验 ----------------------------------------------------------

    def _category_status(self, cat: str, items: list[sqlite3.Row]) -> tuple[str, str]:
        """由该列各物品结果汇总列状态与处理原因。"""
        rank = {"ok": 0, "missing": 1, "damaged": 2, "contaminated": 3}
        worst = "ok"
        reasons = []
        for it in items:
            s = it["condition"]
            if it["qty_returned"] < it["qty_expected"]:
                s = "missing"
            if rank[s] > rank[worst]:
                worst = s
            if s != "ok":
                short = it["qty_expected"] - it["qty_returned"]
                detail = it["reason"] or {
                    "missing": f"缺{short}件",
                    "damaged": "损坏",
                    "contaminated": "污染需隔离",
                }[s]
                reasons.append(f"{it['item_name']}（{detail}）")
        return worst, "；".join(reasons)

    def return_bed(self, assignment_id: int, nurse_id: int,
                   item_results: dict, photo_b64: str = "",
                   photo_name: str = "") -> dict:
        """归还核验。item_results: {bed_item_id: {qty_returned, condition, reason}}。

        床架/床垫/床品/配件四列固定；异常列带出处理原因。
        """
        try:
            self.conn.execute("BEGIN IMMEDIATE")
            asg = self.conn.execute(
                "SELECT * FROM assignments WHERE id=?", (assignment_id,)
            ).fetchone()
            if asg is None:
                raise ServiceError("订单不存在", "assignment_missing")
            # 结算后锁定：迟到归还不能重开订单
            if asg["status"] == "settled":
                raise ServiceError(
                    "订单已结算并锁定，迟到归还不能重开，请走异常登记",
                    "order_locked")
            if asg["status"] != "active":
                raise ServiceError("订单不在使用中", "not_active")
            self._check_ward(nurse_id, asg["ward_id"], "归还核验")

            items = self.conn.execute(
                "SELECT * FROM bed_items WHERE assignment_id=? ORDER BY id",
                (assignment_id,),
            ).fetchall()
            ids = {str(it["id"]) for it in items}
            for k, v in item_results.items():
                if k not in ids:
                    raise ServiceError(f"清单项 {k} 不属于该订单", "item_mismatch")
                qty_ret = int(v.get("qty_returned", 0))
                cond = v.get("condition", "ok")
                if cond not in ("ok", "missing", "damaged", "contaminated"):
                    raise ServiceError("异常状态不合法", "bad_condition")
                original = next(i for i in items if str(i["id"]) == k)
                if qty_ret > original["qty_expected"]:
                    raise ServiceError(
                        f"{original['item_name']} 归还数量超过应发数量",
                        "qty_exceeded")
                self.conn.execute(
                    "UPDATE bed_items SET qty_returned=?, condition=?, reason=?"
                    " WHERE id=?",
                    (qty_ret, cond, v.get("reason", ""), k),
                )

            # 重新读取并汇总四个固定列
            items = self.conn.execute(
                "SELECT * FROM bed_items WHERE assignment_id=? ORDER BY id",
                (assignment_id,),
            ).fetchall()
            col = {}
            for cat, _ in CATEGORIES:
                col[cat] = self._category_status(
                    cat, [i for i in items if i["category"] == cat])

            # 时间字符串 YYYY-MM-DD HH:MM:SS 可直接比较
            late = self._now() > asg["planned_end_at"]

            photo_path = ""
            if photo_b64:
                photo_path = self._save_photo(
                    "return", assignment_id, photo_b64, photo_name)

            cur = self.conn.execute(
                "INSERT INTO returns"
                "(assignment_id, frame_status, frame_reason, mattress_status,"
                " mattress_reason, linen_status, linen_reason, accessory_status,"
                " accessory_reason, late, photo_path, verified_by, returned_at)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (assignment_id,
                 col["frame"][0], col["frame"][1],
                 col["mattress"][0], col["mattress"][1],
                 col["linen"][0], col["linen"][1],
                 col["accessory"][0], col["accessory"][1],
                 int(late), photo_path, nurse_id, self._now()),
            )
            ret_id = cur.lastrowid

            # 床位状态：污染 → isolated；否则 dirty，等待消毒
            contaminated = any(
                col[c][0] == "contaminated" for c, _ in CATEGORIES)
            new_status = "isolated" if contaminated else "dirty"
            self.conn.execute(
                "UPDATE beds SET cleaning_status=? WHERE id=?",
                (new_status, asg["bed_id"]),
            )
            self.conn.execute(
                "UPDATE assignments SET status='returned', actual_end_at=? "
                "WHERE id=?",
                (self._now(), assignment_id),
            )

            # 异常事件
            if col["linen"][0] != "ok":
                self._exception("linen_missing",
                                f"床品异常：{col['linen'][1]}",
                                "assignment", assignment_id, asg["ward_id"])
            if col["accessory"][0] == "missing":
                self._exception("linen_missing",
                                f"配件缺失：{col['accessory'][1]}",
                                "assignment", assignment_id, asg["ward_id"])
            if contaminated:
                self._exception("isolation",
                                f"床位污染，转入隔离：{asg['bed_id']}",
                                "bed", asg["bed_id"], asg["ward_id"])
            if late:
                self._exception("overdue",
                                f"使用超时：计划截止 {asg['planned_end_at']}",
                                "assignment", assignment_id, asg["ward_id"])

            self.conn.commit()
            return {"return_id": ret_id, "late": bool(late),
                    "columns": {c: {"status": col[c][0], "reason": col[c][1]}
                                for c, _ in CATEGORIES},
                    "bed_cleaning": new_status}
        except ServiceError:
            self.conn.rollback()
            raise
        except Exception:
            self.conn.rollback()
            raise

    def _save_photo(self, ref_type: str, ref_id: int,
                    b64: str, name: str) -> str:
        raw = base64.b64decode(b64)
        ts = datetime.now().strftime("%Y%m%d%H%M%S")
        suffix = ".jpg"
        if name and "." in name:
            suffix = "." + name.rsplit(".", 1)[-1][:5]
        fname = f"{ref_type}-{ref_id}-{ts}{suffix}"
        path = self.photos_dir / fname
        path.write_bytes(raw)
        self.conn.execute(
            "INSERT INTO photos(ref_type, ref_id, path, created_at)"
            " VALUES(?,?,?,?)",
            (ref_type, ref_id, str(path), self._now()),
        )
        return str(path)

    # -- 消毒批次 ----------------------------------------------------------

    def create_batch(self, bed_id: int, nurse_id: int,
                     operator: str) -> dict:
        bed = self.conn.execute("SELECT * FROM beds WHERE id=?",
                                (bed_id,)).fetchone()
        if bed is None:
            raise ServiceError("床位不存在", "bed_missing")
        self._check_ward(nurse_id, bed["ward_id"], "创建消毒批次")
        if bed["cleaning_status"] == "clean":
            raise ServiceError("床位已是清洁状态，无需消毒", "already_clean")
        code = f"D-{datetime.now().strftime('%Y%m%d%H%M%S')}-{bed['code']}-{self._nonce(4)}"
        cur = self.conn.execute(
            "INSERT INTO batches(code, bed_id, ward_id, status, operator,"
            " started_at, note) VALUES(?,?,?, 'in_progress', ?, ?, ?)",
            (code, bed["id"], bed["ward_id"], operator, self._now(),
             "污染隔离消毒" if bed["cleaning_status"] == "isolated" else "常规消毒"),
        )
        self.conn.commit()
        return {"batch_id": cur.lastrowid, "code": code}

    def finish_batch(self, batch_id: int, passed: bool,
                     note: str = "") -> dict:
        """合格 → 床位重新 clean 可预约；失败 → 保持阻断并登记异常。"""
        try:
            self.conn.execute("BEGIN IMMEDIATE")
            bt = self.conn.execute("SELECT * FROM batches WHERE id=?",
                                   (batch_id,)).fetchone()
            if bt is None:
                raise ServiceError("批次不存在", "batch_missing")
            if bt["status"] not in ("pending", "in_progress"):
                raise ServiceError("批次已结束", "batch_done")
            if passed:
                self.conn.execute(
                    "UPDATE beds SET cleaning_status='clean' WHERE id=?",
                    (bt["bed_id"],))
                self.conn.execute(
                    "UPDATE batches SET status='passed', finished_at=?,"
                    " note=? WHERE id=?",
                    (self._now(), note or "消毒合格", batch_id))
            else:
                # 失败：维持原阻断状态（isolated/dirty），不得放行
                bed = self.conn.execute("SELECT * FROM beds WHERE id=?",
                                        (bt["bed_id"],)).fetchone()
                self.conn.execute(
                    "UPDATE batches SET status='failed', finished_at=?,"
                    " note=? WHERE id=?",
                    (self._now(), note or "消毒失败，需返工", batch_id))
                self._exception(
                    "disinfect_failed",
                    f"批次 {bt['code']} 消毒失败，床位 {bed['code']} 继续阻断",
                    "batch", batch_id, bt["ward_id"])
            self.conn.commit()
            return {"batch_id": batch_id, "passed": passed}
        except ServiceError:
            self.conn.rollback()
            raise
        except Exception:
            self.conn.rollback()
            raise

    # -- 维修 --------------------------------------------------------------

    def open_maintenance(self, bed_id: int, reason: str,
                         opened_by: str) -> dict:
        bed = self.conn.execute("SELECT * FROM beds WHERE id=?",
                                (bed_id,)).fetchone()
        if bed is None:
            raise ServiceError("床位不存在", "bed_missing")
        active = self.conn.execute(
            "SELECT 1 FROM assignments WHERE bed_id=? AND status='active'",
            (bed_id,)).fetchone()
        if active:
            raise ServiceError("床位使用中，须先临时换床再报修", "bed_occupied")
        cur = self.conn.execute(
            "INSERT INTO maintenance(bed_id, reason, status, opened_by, opened_at)"
            " VALUES(?, 'open', ?, ?)",
            (bed_id, reason, opened_by, self._now()))
        self.conn.execute("UPDATE beds SET maintenance='maintenance' WHERE id=?",
                          (bed_id,))
        self.conn.commit()
        return {"maintenance_id": cur.lastrowid}

    def close_maintenance(self, bed_id: int) -> None:
        self.conn.execute(
            "UPDATE maintenance SET status='closed', closed_at=? "
            "WHERE bed_id=? AND status='open'",
            (self._now(), bed_id))
        self.conn.execute("UPDATE beds SET maintenance='ok' WHERE id=?",
                          (bed_id,))
        self.conn.commit()

    # -- 临时换床 ----------------------------------------------------------

    def swap_bed(self, assignment_id: int, to_bed_id: int,
                 nurse_id: int, reason: str) -> dict:
        with self._alloc_lock:
            try:
                self.conn.execute("BEGIN IMMEDIATE")
                asg = self.conn.execute(
                    "SELECT * FROM assignments WHERE id=?", (assignment_id,)
                ).fetchone()
                if asg is None or asg["status"] != "active":
                    raise ServiceError("订单不存在或未在使用", "not_active")
                self._check_ward(nurse_id, asg["ward_id"], "临时换床")
                target = self.conn.execute(
                    "SELECT * FROM beds WHERE id=?", (to_bed_id,)).fetchone()
                if target is None:
                    raise ServiceError("目标床位不存在", "bed_missing")
                if target["ward_id"] != asg["ward_id"]:
                    raise ServiceError("不得跨病区临时换床", "ward_mismatch")
                if target["maintenance"] == "maintenance":
                    raise ServiceError("目标床位维修中", "bed_maintenance")
                if target["cleaning_status"] != "clean":
                    raise ServiceError("目标床位未完成清洁消毒", "bed_dirty")
                taken = self.conn.execute(
                    "SELECT 1 FROM assignments WHERE bed_id=? AND status='active'",
                    (to_bed_id,)).fetchone()
                if taken:
                    raise ServiceError("目标床位已被占用", "bed_race")

                from_bed = asg["bed_id"]
                self.conn.execute(
                    "UPDATE assignments SET bed_id=? WHERE id=?",
                    (to_bed_id, assignment_id))
                self.conn.execute(
                    "INSERT INTO swaps(assignment_id, from_bed_id, to_bed_id,"
                    " reason, nurse_id, created_at) VALUES(?,?,?,?,?,?)",
                    (assignment_id, from_bed, to_bed_id, reason, nurse_id,
                     self._now()))
                # 原床转待清洁，必要时转维修由调用方另行报修
                self.conn.execute(
                    "UPDATE beds SET cleaning_status='dirty' WHERE id=?",
                    (from_bed,))
                self._exception("swap",
                                f"临时换床 {from_bed}→{to_bed_id}：{reason}",
                                "assignment", assignment_id, asg["ward_id"])
                self.conn.commit()
                return {"from_bed_id": from_bed, "to_bed_id": to_bed_id}
            except ServiceError:
                self.conn.rollback()
                raise
            except sqlite3.IntegrityError as e:
                self.conn.rollback()
                raise ServiceError(f"换床竞争失败：{e}", "bed_race") from e
            except Exception:
                self.conn.rollback()
                raise

    # -- 病区调拨 ----------------------------------------------------------

    def transfer(self, from_ward_id: int, to_ward_id: int, qty: int,
                 responsible_person: str, nurse_id: int,
                 item_type: str = "陪护床", note: str = "") -> dict:
        if from_ward_id == to_ward_id:
            raise ServiceError("调出与调入病区不能相同", "same_ward")
        if qty <= 0:
            raise ServiceError("调拨数量必须大于 0", "bad_qty")
        if not responsible_person.strip():
            raise ServiceError("病区调拨必须登记责任人", "no_responsible")
        self._check_ward(nurse_id, from_ward_id, "病区调拨")
        code = f"T-{datetime.now().strftime('%Y%m%d%H%M%S')}-{from_ward_id}-{to_ward_id}-{self._nonce(4)}"
        moved: list[str] = []
        if item_type == "陪护床":
            rows = self.conn.execute(
                "SELECT b.* FROM beds b "
                "WHERE b.ward_id=? AND b.maintenance='ok' "
                "AND b.cleaning_status='clean' "
                "AND NOT EXISTS(SELECT 1 FROM assignments a "
                "  WHERE a.bed_id=b.id AND a.status='active') "
                "ORDER BY b.code LIMIT ?",
                (from_ward_id, qty)).fetchall()
            if len(rows) < qty:
                raise ServiceError(
                    f"可调出床位不足：需要 {qty}，可用 {len(rows)}",
                    "qty_unavailable")
            for r in rows:
                self.conn.execute("UPDATE beds SET ward_id=? WHERE id=?",
                                  (to_ward_id, r["id"]))
                moved.append(r["code"])
        cur = self.conn.execute(
            "INSERT INTO transfers(code, from_ward_id, to_ward_id, item_type,"
            " qty, responsible_person, handed_at, note) VALUES(?,?,?,?,?,?,?,?)",
            (code, from_ward_id, to_ward_id, item_type, qty,
             responsible_person, self._now(),
             (note + " 床位:" + ",".join(moved)).strip()),
        )
        self.conn.commit()
        return {"transfer_id": cur.lastrowid, "code": code, "moved": moved}

    # -- 押金结算 ----------------------------------------------------------

    def settle(self, assignment_id: int, deduct: int = 0,
               deduct_reason: str = "") -> dict:
        asg = self.conn.execute("SELECT * FROM assignments WHERE id=?",
                                (assignment_id,)).fetchone()
        if asg is None:
            raise ServiceError("订单不存在", "assignment_missing")
        if asg["status"] == "settled":
            raise ServiceError("订单已结算，不可重复结算", "already_settled")
        if asg["status"] != "returned":
            raise ServiceError("只有已归还订单可以结算", "not_returned")
        if deduct > 0:
            key = f"deduct-{assignment_id}-{deduct}-{deduct_reason}"
            try:
                self.deposits.deduct(assignment_id, deduct, key,
                                     deduct_reason or "押金扣减")
            except DepositError as e:
                raise ServiceError(str(e), "deposit_error") from e
            if deduct_reason:
                self._exception("deposit_diff",
                                f"押金扣减 {deduct/100:.2f} 元：{deduct_reason}",
                                "assignment", assignment_id, asg["ward_id"])
        summary = self.deposits.settle(
            assignment_id, f"settle-{assignment_id}")
        self.conn.execute(
            "UPDATE assignments SET status='settled' WHERE id=?",
            (assignment_id,))
        self.conn.commit()
        return summary

    # -- 申请 ----------------------------------------------------------------

    def create_request(self, applicant_id: int, ward_id: int, spec: str,
                       expected_start: str, expected_end: str,
                       note: str = "") -> int:
        code = f"R-{datetime.now().strftime('%Y%m%d%H%M%S')}-{applicant_id}"
        cur = self.conn.execute(
            "INSERT INTO requests(code, applicant_id, ward_id, spec, status,"
            " expected_start, expected_end, created_at, note)"
            " VALUES(?,?,?,?, 'queued', ?, ?, ?, ?)",
            (code, applicant_id, ward_id, spec, expected_start,
             expected_end, self._now(), note))
        self.conn.commit()
        return cur.lastrowid
