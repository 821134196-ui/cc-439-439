"""匿名演示数据：病区、床位、护士、申请人及一整套业务样例。

涵盖：待处理申请、使用中订单、正常归还、使用超时、床品/配件缺失、
污染隔离、消毒失败、维修、临时换床、病区调拨、押金结算。
患者与家属均使用匿名称谓，无真实个人信息。
"""
from __future__ import annotations

import sqlite3
import struct
import zlib
from datetime import datetime, timedelta
from pathlib import Path

from .db import init_db
from .deposit import InMemoryDepositAdapter
from .services import DEPOSIT_BY_SPEC, STANDARD_KIT, Service

# 配色（占位照片用）：墨蓝 / 湖绿 / 暖灰
COLORS = {
    "return": (38, 84, 124),
    "batch": (32, 158, 142),
    "transfer": (120, 130, 140),
}


def _make_png(path: Path, rgb: tuple[int, int, int],
              w: int = 48, h: int = 48) -> None:
    """生成一张纯色占位 PNG（无第三方依赖）。"""
    def chunk(tag: bytes, data: bytes) -> bytes:
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(
            ">I", zlib.crc32(c) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    path.write_bytes(png)


def _photo(photos_dir: Path, conn: sqlite3.Connection,
           ref_type: str, ref_id: int, ts: str) -> str:
    fname = f"{ref_type}-{ref_id}-{ts.strftime('%Y%m%d%H%M%S')}.png"
    path = photos_dir / fname
    _make_png(path, COLORS.get(ref_type, (120, 120, 120)))
    conn.execute(
        "INSERT INTO photos(ref_type, ref_id, path, created_at) VALUES(?,?,?,?)",
        (ref_type, ref_id, str(path), ts.strftime("%Y-%m-%d %H:%M:%S")))
    return str(path)


def seed_all(conn: sqlite3.Connection, photos_dir: str | Path,
             reset: bool = False) -> None:
    photos_dir = Path(photos_dir)
    photos_dir.mkdir(parents=True, exist_ok=True)
    if reset:
        conn.executescript(
            "PRAGMA foreign_keys=OFF; "
            + " ".join(f"DROP TABLE IF EXISTS {t};" for t in (
                "photos", "exceptions", "deposits", "deposit_ledger",
                "transfers", "maintenance", "batches", "returns",
                "bed_items", "swaps", "assignments", "requests",
                "applicants", "beds", "nurses", "wards"))
            + " PRAGMA foreign_keys=ON;")
        conn.commit()
    init_db(conn)
    svc = Service(conn, photos_dir)
    dep = InMemoryDepositAdapter(conn)
    now = datetime.now()

    def ts(dt: datetime) -> str:
        return dt.strftime("%Y-%m-%d %H:%M:%S")

    # ---------- 病区 ----------
    wards = [
        ("N3", "内科三病区"),
        ("S2", "外科二病区"),
        ("P1", "儿科病区"),
    ]
    ward_ids = {}
    for code, name in wards:
        cur = conn.execute("INSERT INTO wards(code, name) VALUES(?,?)",
                           (code, name))
        ward_ids[code] = cur.lastrowid

    # ---------- 护士 ----------
    nurse_rows = [
        ("周护士", ward_ids["N3"]), ("吴护士", ward_ids["N3"]),
        ("郑护士", ward_ids["S2"]), ("王护士", ward_ids["S2"]),
        ("冯护士", ward_ids["P1"]),
    ]
    nurse_id = {}
    for name, wid in nurse_rows:
        cur = conn.execute("INSERT INTO nurses(name, ward_id) VALUES(?,?)",
                           (name, wid))
        nurse_id[name] = cur.lastrowid

    # ---------- 床位 ----------
    # (病区, 编号, 规格, 清洁, 维修)
    bed_defs = [
        ("N3", "N3-01", "标准床", "clean", "ok"),
        ("N3", "N3-02", "标准床", "clean", "ok"),
        ("N3", "N3-03", "加宽床", "clean", "ok"),
        ("N3", "N3-04", "标准床", "dirty", "ok"),    # 待清洁，阻断样例
        ("N3", "N3-05", "加宽床", "clean", "maintenance"),  # 维修中
        ("S2", "S2-01", "标准床", "clean", "ok"),
        ("S2", "S2-02", "加宽床", "clean", "ok"),
        ("S2", "S2-03", "标准床", "isolated", "ok"),  # 污染隔离
        ("S2", "S2-04", "标准床", "clean", "ok"),
        ("P1", "P1-01", "标准床", "clean", "ok"),
        ("P1", "P1-02", "加宽床", "dirty", "ok"),
        ("P1", "P1-03", "加宽床", "clean", "ok"),
    ]
    bed_id = {}
    for wcode, code, spec, clean, maint in bed_defs:
        note = ""
        if maint == "maintenance":
            note = "床架折叠铰链异响"
        cur = conn.execute(
            "INSERT INTO beds(ward_id, code, spec, cleaning_status,"
            " maintenance, note) VALUES(?,?,?,?,?,?)",
            (ward_ids[wcode], code, spec, clean, maint, note))
        bed_id[code] = cur.lastrowid

    # ---------- 匿名申请人 ----------
    applicants = [
        ("P-1001", "匿名患者·甲", "配偶", "联系尾号 ****021"),
        ("P-1002", "匿名患者·乙", "子女", "联系尾号 ****782"),
        ("P-1003", "匿名患者·丙", "父母", "联系尾号 ****356"),
        ("P-1004", "匿名患者·丁", "配偶", "联系尾入尾号 ****904"),
        ("P-1005", "匿名患者·戊", "子女", "联系尾号 ****118"),
        ("P-1006", "匿名患者·己", "父母", "联系尾号 ****640"),
        ("P-1007", "匿名患者·庚", "配偶", "联系尾号 ****275"),
    ]
    app_id = {}
    for code, tag, rel, hint in applicants:
        hint = hint.replace("联系尾入尾号", "联系尾号")
        cur = conn.execute(
            "INSERT INTO applicants(code, patient_tag, relation, contact_hint)"
            " VALUES(?,?,?,?)", (code, tag, rel, hint))
        app_id[code] = cur.lastrowid

    # ---------- 申请队列 ----------
    def make_request(code, app_code, wcode, spec, status, start, end,
                     note=""):
        cur = conn.execute(
            "INSERT INTO requests(code, applicant_id, ward_id, spec, status,"
            " expected_start, expected_end, created_at, note)"
            " VALUES(?,?,?,?,?,?,?,?,?)",
            (code, app_id[app_code], ward_ids[wcode], spec, status,
             ts(start), ts(end), ts(start - timedelta(hours=2)), note))
        return cur.lastrowid

    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    # 待处理队列
    make_request("R-Q001", "P-1001", "N3", "标准床", "queued",
                 today + timedelta(hours=14), today + timedelta(days=2, hours=10),
                 "夜间陪护")
    make_request("R-Q002", "P-1002", "N3", "加宽床", "queued",
                 today + timedelta(hours=16), today + timedelta(days=3),
                 "体型较宽需加宽")
    make_request("R-Q003", "P-1005", "S2", "标准床", "queued",
                 today + timedelta(hours=18), today + timedelta(days=1, hours=12))
    make_request("R-Q004", "P-1006", "P1", "标准床", "queued",
                 today + timedelta(hours=20), today + timedelta(days=2))

    # ---------- 构造订单的辅助 ----------
    def make_assignment(code, req_id, bed_code, nurse, start, end,
                        status, actual_end=None):
        cur = conn.execute(
            "INSERT INTO assignments(code, request_id, bed_id, ward_id,"
            " nurse_id, start_at, planned_end_at, actual_end_at, status,"
            " created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (code, req_id, bed_id[bed_code],
             conn.execute("SELECT ward_id FROM beds WHERE id=?",
                          (bed_id[bed_code],)).fetchone()[0],
             nurse_id[nurse], ts(start), ts(end),
             ts(actual_end) if actual_end else None, status, ts(start)))
        aid = cur.lastrowid
        for cat, name, qty in STANDARD_KIT:
            conn.execute(
                "INSERT INTO bed_items(assignment_id, category, item_name,"
                " qty_expected, qty_returned, condition)"
                " VALUES(?,?,?,?,0,'ok')",
                (aid, cat, name, qty))
        dep.hold(aid, DEPOSIT_BY_SPEC[
            conn.execute("SELECT spec FROM requests WHERE id=?",
                         (req_id,)).fetchone()[0]],
                 f"seed-hold-{aid}")
        return aid

    # 1) 两个使用中订单（占用 N3-01 / S2-01）
    r1 = make_request("R-A001", "P-1003", "N3", "标准床", "assigned",
                      today - timedelta(hours=10),
                      today + timedelta(days=1, hours=10))
    a1 = make_assignment("O-A001", r1, "N3-01", "周护士",
                         today - timedelta(hours=10),
                         today + timedelta(days=1, hours=10), "active")

    r2 = make_request("R-A002", "P-1007", "S2", "标准床", "assigned",
                      today - timedelta(hours=6),
                      today + timedelta(days=2))
    a2 = make_assignment("O-A002", r2, "S2-01", "郑护士",
                         today - timedelta(hours=6),
                         today + timedelta(days=2), "active")

    # 2) 正常归还 + 已结算（N3-02：归还→消毒合格→clean，已退款）
    r3 = make_request("R-A003", "P-1004", "N3", "标准床", "assigned",
                      today - timedelta(days=3),
                      today - timedelta(days=1, hours=22))
    a3 = make_assignment("O-A003", r3, "N3-02", "吴护士",
                         today - timedelta(days=3),
                         today - timedelta(days=1, hours=22), "settled",
                         today - timedelta(days=1, hours=21))
    _seed_return(conn, photos_dir, a3, nurse_id["周护士"],
                 today - timedelta(days=1, hours=21),
                 overrides={}, late=False)
    b3 = conn.execute(
        "INSERT INTO batches(code, bed_id, ward_id, status, operator,"
        " started_at, finished_at, note) VALUES(?,?,?,?,?,?,?,?)",
        ("D-SEED-03", bed_id["N3-02"], ward_ids["N3"], "passed", "消毒员·钱",
         ts(today - timedelta(days=1, hours=20)),
         ts(today - timedelta(days=1, hours=19)), "常规消毒合格")).lastrowid
    conn.execute("UPDATE beds SET cleaning_status='clean' WHERE id=?",
                 (bed_id["N3-02"],))
    dep.settle(a3, f"seed-settle-{a3}")
    conn.execute("UPDATE assignments SET status='settled' WHERE id=?", (a3,))

    # 3) 使用超时归还 + 已结算（S2-04）
    r4 = make_request("R-A004", "P-1002", "S2", "标准床", "assigned",
                      today - timedelta(days=4),
                      today - timedelta(days=2, hours=18))
    a4 = make_assignment("O-A004", r4, "S2-04", "王护士",
                         today - timedelta(days=4),
                         today - timedelta(days=2, hours=18), "settled",
                         today - timedelta(days=2, hours=21))
    _seed_return(conn, photos_dir, a4, nurse_id["郑护士"],
                 today - timedelta(days=2, hours=21),
                 overrides={}, late=True)
    conn.execute(
        "INSERT INTO batches(code, bed_id, ward_id, status, operator,"
        " started_at, finished_at, note) VALUES(?,?,?,?,?,?,?,?)",
        ("D-SEED-04", bed_id["S2-04"], ward_ids["S2"], "passed", "消毒员·钱",
         ts(today - timedelta(days=2, hours=20)),
         ts(today - timedelta(days=2, hours=19)), "消毒合格"))
    conn.execute("UPDATE beds SET cleaning_status='clean' WHERE id=?",
                 (bed_id["S2-04"],))
    # 超时扣 50 元
    dep.deduct(a4, 5000, f"seed-deduct-{a4}", "使用超时扣费")
    conn.execute(
        "INSERT INTO exceptions(type, ref_type, ref_id, ward_id, note,"
        " created_at) VALUES('deposit_diff','assignment',?,?,?,?)",
        (a4, ward_ids["S2"], "押金差异：超时扣费 50.00 元",
         ts(today - timedelta(days=2, hours=21))))
    dep.settle(a4, f"seed-settle-{a4}")
    conn.execute("UPDATE assignments SET status='settled' WHERE id=?", (a4,))
    conn.execute(
        "INSERT INTO exceptions(type, ref_type, ref_id, ward_id, note,"
        " created_at) VALUES('overdue','assignment',?,?,?,?)",
        (a4, ward_ids["S2"], "历史样例：超时 3 小时归还，扣 50 元",
         ts(today - timedelta(days=2, hours=21))))

    # 4) 床品缺失 + 配件缺失，已归还待结算（S2-02 加宽）
    r5 = make_request("R-A005", "P-1005", "S2", "加宽床", "assigned",
                      today - timedelta(days=2),
                      today - timedelta(hours=3))
    a5 = make_assignment("O-A005", r5, "S2-02", "王护士",
                         today - timedelta(days=2),
                         today - timedelta(hours=3), "returned",
                         now - timedelta(hours=1))
    _seed_return(conn, photos_dir, a5, nurse_id["郑护士"],
                 now - timedelta(hours=1),
                 overrides={"枕套": (0, "missing", "未找到枕套"),
                            "呼叫器": (0, "missing", "家属称遗落家中")},
                 late=False)
    conn.execute("UPDATE beds SET cleaning_status='dirty' WHERE id=?",
                 (bed_id["S2-02"],))
    conn.execute(
        "INSERT INTO exceptions(type, ref_type, ref_id, ward_id, note,"
        " created_at) VALUES('linen_missing','assignment',?,?,?,?)",
        (a5, ward_ids["S2"], "床品缺失：枕套（未找到枕套）",
         ts(now - timedelta(hours=1))))
    conn.execute(
        "INSERT INTO exceptions(type, ref_type, ref_id, ward_id, note,"
        " created_at) VALUES('linen_missing','assignment',?,?,?,?)",
        (a5, ward_ids["S2"], "配件缺失：呼叫器（家属称遗落家中），按价待扣押金",
         ts(now - timedelta(hours=1))))
    # 消毒批次进行中 → 该床仍阻断
    conn.execute(
        "INSERT INTO batches(code, bed_id, ward_id, status, operator,"
        " started_at, note) VALUES(?,?,?, 'in_progress', ?, ?, ?)",
        ("D-SEED-05", bed_id["S2-02"], ward_ids["S2"], "消毒员·钱",
         ts(now - timedelta(minutes=40)), "常规消毒"))

    # 5) 污染隔离 + 消毒失败（S2-03：归还污染→批次失败→继续隔离）
    r6 = make_request("R-A006", "P-1006", "S2", "标准床", "assigned",
                      today - timedelta(days=1, hours=20),
                      today - timedelta(hours=5))
    a6 = make_assignment("O-A006", r6, "S2-03", "郑护士",
                         today - timedelta(days=1, hours=20),
                         today - timedelta(hours=5), "returned",
                         now - timedelta(hours=2))
    _seed_return(conn, photos_dir, a6, nurse_id["王护士"],
                 now - timedelta(hours=2),
                 overrides={"床单": (1, "contaminated", "可见体液污染"),
                            "海绵床垫": (1, "contaminated", "渗透性污染")},
                 late=False)
    conn.execute("UPDATE beds SET cleaning_status='isolated' WHERE id=?",
                 (bed_id["S2-03"],))
    conn.execute(
        "INSERT INTO exceptions(type, ref_type, ref_id, ward_id, note,"
        " created_at) VALUES('isolation','bed',?,?,?,?)",
        (bed_id["S2-03"], ward_ids["S2"],
         "床位污染，转入隔离：床单、海绵床垫检出污染",
         ts(now - timedelta(hours=2))))
    fbatch = conn.execute(
        "INSERT INTO batches(code, bed_id, ward_id, status, operator,"
        " started_at, finished_at, note) VALUES(?,?,?,?,?,?,?,?)",
        ("D-SEED-06F", bed_id["S2-03"], ward_ids["S2"], "failed", "消毒员·孙",
         ts(now - timedelta(hours=1, minutes=50)),
         ts(now - timedelta(hours=1)), "采样培养阳性，消毒失败需返工")).lastrowid
    conn.execute(
        "INSERT INTO exceptions(type, ref_type, ref_id, ward_id, note,"
        " created_at) VALUES('disinfect_failed','batch',?,?,?,?)",
        (fbatch, ward_ids["S2"],
         f"批次 D-SEED-06F 消毒失败，床位 S2-03 继续隔离",
         ts(now - timedelta(hours=1))))
    conn.execute(
        "INSERT INTO batches(code, bed_id, ward_id, status, operator,"
        " started_at, note) VALUES(?,?,?, 'in_progress', ?, ?, ?)",
        ("D-SEED-06R", bed_id["S2-03"], ward_ids["S2"], "消毒员·孙",
         ts(now - timedelta(minutes=20)), "二次强化消毒"))

    # 6) 临时换床样例：P1-03 使用中，曾从 P1-02 换入
    r7 = make_request("R-A007", "P-1001", "P1", "加宽床", "assigned",
                      today - timedelta(hours=8),
                      today + timedelta(days=1, hours=8))
    a7 = make_assignment("O-A007", r7, "P1-02", "冯护士",
                         today - timedelta(hours=8),
                         today + timedelta(days=1, hours=8), "active")
    # 从 P1-02（加宽）临时换到 P1-03（加宽，同规格同病区）
    conn.execute(
        "UPDATE assignments SET bed_id=? WHERE id=?",
        (bed_id["P1-03"], a7))
    conn.execute(
        "INSERT INTO swaps(assignment_id, from_bed_id, to_bed_id, reason,"
        " nurse_id, created_at) VALUES(?,?,?,?,?,?)",
        (a7, bed_id["P1-02"], bed_id["P1-03"], "原床位靠窗漏风，家属申请更换",
         nurse_id["冯护士"], ts(today - timedelta(hours=5))))
    conn.execute("UPDATE beds SET cleaning_status='dirty' WHERE id=?",
                 (bed_id["P1-02"],))
    conn.execute(
        "INSERT INTO exceptions(type, ref_type, ref_id, ward_id, note,"
        " created_at) VALUES('swap','assignment',?,?,?,?)",
        (a7, ward_ids["P1"], "临时换床 P1-02→P1-03：原床位靠窗漏风",
         ts(today - timedelta(hours=5))))

    # ---------- 维修工单 ----------
    conn.execute(
        "INSERT INTO maintenance(bed_id, reason, status, opened_by, opened_at)"
        " VALUES(?, ?, 'open', ?, ?)",
        (bed_id["N3-05"], "折叠铰链卡滞，等待配件更换", "后勤·陈",
         ts(now - timedelta(hours=30))))

    # ---------- 病区调拨（已完成，记录数量与责任人）----------
    # 调拨需移动真实床位：把 P1 的一张床先挪给 S2 会破坏上面引用，
    # 因此这里采用新建两张“流转床”再做一次调拨样例。
    for code, wid in (("X-101", ward_ids["P1"]), ("X-102", ward_ids["P1"])):
        conn.execute(
            "INSERT INTO beds(ward_id, code, spec, cleaning_status,"
            " maintenance, note) VALUES(?,?,'标准床','clean','ok','调拨周转床')",
            (wid, code))
    x1 = conn.execute("SELECT id FROM beds WHERE code='X-101'").fetchone()[0]
    x2 = conn.execute("SELECT id FROM beds WHERE code='X-102'").fetchone()[0]
    conn.execute("UPDATE beds SET ward_id=? WHERE id IN (?,?)",
                 (ward_ids["S2"], x1, x2))
    conn.execute("UPDATE beds SET code='S2-05' WHERE id=?", (x1,))
    conn.execute("UPDATE beds SET code='S2-06' WHERE id=?", (x2,))
    handed = now - timedelta(days=1, hours=3)
    tphoto = _photo(photos_dir, conn, "transfer", 0, handed)
    conn.execute(
        "INSERT INTO transfers(code, from_ward_id, to_ward_id, item_type,"
        " qty, responsible_person, handed_at, note)"
        " VALUES('T-SEED-01',?,?, '陪护床', 2, ?, ?, ?)",
        (ward_ids["P1"], ward_ids["S2"], "责任护士·冯 / 接收护士·郑",
         ts(handed), f"夜间床位支援 交接照片:{tphoto} 床位:S2-05,S2-06"))

    conn.commit()


def _seed_return(conn, photos_dir, assignment_id, nurse_id, at,
                 overrides=None, late=False):
    """构造一条归还核验记录，并回写床品数量。

    overrides: {物品名: (qty_returned, condition, reason)}
    """
    overrides = overrides or {}
    items = conn.execute(
        "SELECT * FROM bed_items WHERE assignment_id=?",
        (assignment_id,)).fetchall()
    cols = {"frame": ["ok", ""], "mattress": ["ok", ""],
            "linen": ["ok", ""], "accessory": ["ok", ""]}
    rank = {"ok": 0, "missing": 1, "damaged": 2, "contaminated": 3}
    for it in items:
        qty, cond, reason = it["qty_expected"], "ok", ""
        if it["item_name"] in overrides:
            qty, cond, reason = overrides[it["item_name"]]
        conn.execute(
            "UPDATE bed_items SET qty_returned=?, condition=?, reason=?"
            " WHERE id=?", (qty, cond, reason, it["id"]))
        if rank[cond] > rank[cols[it["category"]][0]]:
            cols[it["category"]] = [cond, reason]
    # 列原因聚合
    for cat in cols:
        reasons = []
        for it in items:
            if it["category"] != cat:
                continue
            qty, cond, reason = it["qty_expected"], "ok", ""
            if it["item_name"] in overrides:
                qty, cond, reason = overrides[it["item_name"]]
            if cond != "ok":
                reasons.append(f"{it['item_name']}（{reason}）")
        if reasons:
            cols[cat][1] = "；".join(reasons)

    ts = at.strftime("%Y%m%d%H%M%S")
    photos_dir = Path(photos_dir)
    fname = f"return-{assignment_id}-{ts}.png"
    _make_png(photos_dir / fname, (38, 84, 124))
    photo_path = str(photos_dir / fname)
    conn.execute(
        "INSERT INTO photos(ref_type, ref_id, path, created_at)"
        " VALUES('return',?,?,?)",
        (assignment_id, photo_path, at.strftime("%Y-%m-%d %H:%M:%S")))
    conn.execute(
        "INSERT INTO returns(assignment_id, frame_status, frame_reason,"
        " mattress_status, mattress_reason, linen_status, linen_reason,"
        " accessory_status, accessory_reason, late, photo_path,"
        " verified_by, returned_at)"
        " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (assignment_id,
         cols["frame"][0], cols["frame"][1],
         cols["mattress"][0], cols["mattress"][1],
         cols["linen"][0], cols["linen"][1],
         cols["accessory"][0], cols["accessory"][1],
         int(late), photo_path, nurse_id,
         at.strftime("%Y-%m-%d %H:%M:%S")))
