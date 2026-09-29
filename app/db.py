"""SQLite 连接与 schema。

所有业务表集中在一个本地数据库文件；床位“正在使用”由 assignments 中
status='active' 的行表达，并通过部分唯一索引保证同一床位最多一个有效订单，
从而在两名护士并发分配同一床位时只允许一人成功。
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

SCHEMA = """
PRAGMA foreign_keys = ON;

-- 病区
CREATE TABLE IF NOT EXISTS wards (
    id          INTEGER PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL
);

-- 护士（责任执行人）；ward_id 为其所属病区，跨病区操作受权限校验
CREATE TABLE IF NOT EXISTS nurses (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    ward_id     INTEGER NOT NULL REFERENCES wards(id),
    role        TEXT NOT NULL DEFAULT '护士'
);

-- 陪护床
-- cleaning_status: clean 已清洁 / dirty 待清洁 / isolated 污染隔离
-- maintenance:     ok 正常 / maintenance 维修中
CREATE TABLE IF NOT EXISTS beds (
    id               INTEGER PRIMARY KEY,
    ward_id          INTEGER NOT NULL REFERENCES wards(id),
    code             TEXT NOT NULL UNIQUE,
    spec             TEXT NOT NULL CHECK (spec IN ('标准床', '加宽床')),
    cleaning_status  TEXT NOT NULL DEFAULT 'clean'
                     CHECK (cleaning_status IN ('clean', 'dirty', 'isolated')),
    maintenance      TEXT NOT NULL DEFAULT 'ok'
                     CHECK (maintenance IN ('ok', 'maintenance')),
    note             TEXT NOT NULL DEFAULT ''
);

-- 匿名申请人（演示资料，不存真实姓名）
CREATE TABLE IF NOT EXISTS applicants (
    id           INTEGER PRIMARY KEY,
    code         TEXT NOT NULL UNIQUE,          -- 如 P-1001
    patient_tag  TEXT NOT NULL,                  -- 匿名称谓，如“匿名患者·甲”
    relation     TEXT NOT NULL DEFAULT '家属',
    contact_hint TEXT NOT NULL DEFAULT ''        -- 脱敏联系方式
);

-- 申请队列
-- status: queued 待处理 / assigned 已确认 / rejected 驳回 / cancelled 已取消
CREATE TABLE IF NOT EXISTS requests (
    id             INTEGER PRIMARY KEY,
    code           TEXT NOT NULL UNIQUE,
    applicant_id   INTEGER NOT NULL REFERENCES applicants(id),
    ward_id        INTEGER NOT NULL REFERENCES wards(id),
    spec           TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'queued',
    expected_start TEXT NOT NULL,
    expected_end   TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    note           TEXT NOT NULL DEFAULT ''
);

-- 使用时段（订单）
-- status: active 使用中 / returned 已归还 / settled 已结算（不可重开）
CREATE TABLE IF NOT EXISTS assignments (
    id             INTEGER PRIMARY KEY,
    code           TEXT NOT NULL UNIQUE,
    request_id     INTEGER NOT NULL REFERENCES requests(id),
    bed_id         INTEGER NOT NULL REFERENCES beds(id),
    ward_id        INTEGER NOT NULL REFERENCES wards(id),
    nurse_id       INTEGER NOT NULL REFERENCES nurses(id),
    start_at       TEXT NOT NULL,
    planned_end_at TEXT NOT NULL,
    actual_end_at  TEXT,
    status         TEXT NOT NULL DEFAULT 'active',
    created_at     TEXT NOT NULL
);
-- 关键并发约束：每张床最多一个未结束订单
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_bed
    ON assignments(bed_id) WHERE status = 'active';

-- 临时换床记录
CREATE TABLE IF NOT EXISTS swaps (
    id            INTEGER PRIMARY KEY,
    assignment_id INTEGER NOT NULL REFERENCES assignments(id),
    from_bed_id   INTEGER NOT NULL REFERENCES beds(id),
    to_bed_id     INTEGER NOT NULL REFERENCES beds(id),
    reason        TEXT NOT NULL DEFAULT '',
    nurse_id      INTEGER NOT NULL REFERENCES nurses(id),
    created_at    TEXT NOT NULL
);

-- 床品 / 配件随附清单（固定四类）
-- category: frame 床架 / mattress 床垫 / linen 床品 / accessory 配件
-- condition: ok 正常 / missing 缺失 / damaged 损坏 / contaminated 污染
CREATE TABLE IF NOT EXISTS bed_items (
    id             INTEGER PRIMARY KEY,
    assignment_id  INTEGER NOT NULL REFERENCES assignments(id),
    category       TEXT NOT NULL CHECK (category IN
                     ('frame', 'mattress', 'linen', 'accessory')),
    item_name      TEXT NOT NULL,
    qty_expected   INTEGER NOT NULL DEFAULT 1,
    qty_returned   INTEGER NOT NULL DEFAULT 0,
    condition      TEXT NOT NULL DEFAULT 'ok',
    reason         TEXT NOT NULL DEFAULT ''
);

-- 归还核验（床架 / 床垫 / 床品 / 配件 四个固定列）
-- 各列状态: ok / missing / damaged / contaminated
CREATE TABLE IF NOT EXISTS returns (
    id                 INTEGER PRIMARY KEY,
    assignment_id      INTEGER NOT NULL UNIQUE REFERENCES assignments(id),
    frame_status       TEXT NOT NULL DEFAULT 'ok',
    frame_reason       TEXT NOT NULL DEFAULT '',
    mattress_status    TEXT NOT NULL DEFAULT 'ok',
    mattress_reason    TEXT NOT NULL DEFAULT '',
    linen_status       TEXT NOT NULL DEFAULT 'ok',
    linen_reason       TEXT NOT NULL DEFAULT '',
    accessory_status   TEXT NOT NULL DEFAULT 'ok',
    accessory_reason   TEXT NOT NULL DEFAULT '',
    late               INTEGER NOT NULL DEFAULT 0,  -- 使用超时
    photo_path         TEXT NOT NULL DEFAULT '',
    verified_by        INTEGER NOT NULL REFERENCES nurses(id),
    returned_at        TEXT NOT NULL
);

-- 消毒批次：status pending 待开始 / in_progress 进行中 / passed 合格 / failed 失败
CREATE TABLE IF NOT EXISTS batches (
    id          INTEGER PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,
    bed_id      INTEGER REFERENCES beds(id),
    ward_id     INTEGER NOT NULL REFERENCES wards(id),
    status      TEXT NOT NULL DEFAULT 'pending',
    operator    TEXT NOT NULL DEFAULT '',
    started_at  TEXT,
    finished_at TEXT,
    note        TEXT NOT NULL DEFAULT ''
);

-- 维修工单：open 期间床位禁止预约
CREATE TABLE IF NOT EXISTS maintenance (
    id         INTEGER PRIMARY KEY,
    bed_id     INTEGER NOT NULL REFERENCES beds(id),
    reason     TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    opened_by  TEXT NOT NULL DEFAULT '',
    opened_at  TEXT NOT NULL,
    closed_at  TEXT
);

-- 病区调拨：必须记录数量与责任人
CREATE TABLE IF NOT EXISTS transfers (
    id                 INTEGER PRIMARY KEY,
    code               TEXT NOT NULL UNIQUE,
    from_ward_id       INTEGER NOT NULL REFERENCES wards(id),
    to_ward_id         INTEGER NOT NULL REFERENCES wards(id),
    item_type          TEXT NOT NULL DEFAULT '陪护床',
    qty                INTEGER NOT NULL CHECK (qty > 0),
    responsible_person TEXT NOT NULL,
    handed_at          TEXT NOT NULL,
    note               TEXT NOT NULL DEFAULT ''
);

-- 押金台账（模拟适配器写入）
CREATE TABLE IF NOT EXISTS deposit_ledger (
    id               INTEGER PRIMARY KEY,
    assignment_id    INTEGER NOT NULL REFERENCES assignments(id),
    action           TEXT NOT NULL CHECK (action IN
                       ('hold', 'refund', 'deduct', 'diff')),
    amount           INTEGER NOT NULL,          -- 金额（分），正数
    idempotency_key  TEXT NOT NULL UNIQUE,      -- 幂等键
    reason           TEXT NOT NULL DEFAULT '',
    created_at       TEXT NOT NULL
);

-- 押金汇总（每个订单一行）
CREATE TABLE IF NOT EXISTS deposits (
    id               INTEGER PRIMARY KEY,
    assignment_id    INTEGER NOT NULL UNIQUE REFERENCES assignments(id),
    hold_amount      INTEGER NOT NULL DEFAULT 0,   -- 冻结金额（分）
    refunded_amount  INTEGER NOT NULL DEFAULT 0,
    deducted_amount  INTEGER NOT NULL DEFAULT 0,
    settled          INTEGER NOT NULL DEFAULT 0,   -- 结算后锁定
    settled_at       TEXT
);

-- 异常事件：临时换床/押金差异/床品缺失/污染隔离/使用超时/消毒失败
CREATE TABLE IF NOT EXISTS exceptions (
    id          INTEGER PRIMARY KEY,
    type        TEXT NOT NULL CHECK (type IN
                  ('swap', 'deposit_diff', 'linen_missing',
                   'isolation', 'overdue', 'disinfect_failed')),
    ref_type    TEXT NOT NULL DEFAULT '',
    ref_id      INTEGER,
    ward_id     INTEGER REFERENCES wards(id),
    note        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL
);

-- 交接照片登记（文件本体在本地目录）
CREATE TABLE IF NOT EXISTS photos (
    id          INTEGER PRIMARY KEY,
    ref_type    TEXT NOT NULL,                 -- return / batch / transfer
    ref_id      INTEGER NOT NULL,
    path        TEXT NOT NULL,
    created_at  TEXT NOT NULL
);
"""


def connect(db_path: str | Path) -> sqlite3.Connection:
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), timeout=15, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 15000")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    conn.commit()
