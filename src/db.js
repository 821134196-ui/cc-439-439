'use strict';
// 数据层：node:sqlite（Node 22 内置），无第三方依赖
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const SCHEMA = `
PRAGMA foreign_keys = ON;

-- 病区
CREATE TABLE IF NOT EXISTS wards (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,          -- 病区代码，如 3W
  name        TEXT NOT NULL,                 -- 如 呼吸内科三病区
  building    TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);

-- 护理人员（演示账号）
CREATE TABLE IF NOT EXISTS staff (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,          -- 工号 N-301
  name        TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '责任护士',
  is_admin    INTEGER NOT NULL DEFAULT 0     -- 总务/管理员可跨病区
);

-- 护士-病区 权限关联（护士只能操作授权病区）
CREATE TABLE IF NOT EXISTS staff_wards (
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  ward_id  INTEGER NOT NULL REFERENCES wards(id),
  PRIMARY KEY (staff_id, ward_id)
);

-- 陪护床
CREATE TABLE IF NOT EXISTS beds (
  id              INTEGER PRIMARY KEY,
  ward_id         INTEGER NOT NULL REFERENCES wards(id),
  code            TEXT NOT NULL,             -- 床号 P-01
  spec            TEXT NOT NULL,             -- 规格：平板床/单摇床/双摇床
  is_clean        INTEGER NOT NULL DEFAULT 1,-- 清洁状态：仅完成消毒批次后才可置 1
  isolated        INTEGER NOT NULL DEFAULT 0,-- 污染隔离
  is_maintenance  INTEGER NOT NULL DEFAULT 0,-- 维修中（存在未关闭维修单）
  current_rental_id INTEGER,                 -- 当前占用的使用单
  created_at      TEXT NOT NULL,
  UNIQUE (ward_id, code)
);

-- 床位固定配件台账（应有数量，归还时核对实际数量）
CREATE TABLE IF NOT EXISTS bed_accessories (
  id           INTEGER PRIMARY KEY,
  bed_id       INTEGER NOT NULL REFERENCES beds(id),
  item         TEXT NOT NULL,
  expected_qty INTEGER NOT NULL DEFAULT 1,
  UNIQUE (bed_id, item)
);

-- 申请人（匿名演示资料）
CREATE TABLE IF NOT EXISTS applicants (
  id           INTEGER PRIMARY KEY,
  anon_code    TEXT NOT NULL UNIQUE,         -- A-1001
  label        TEXT NOT NULL,                -- 匿名称呼，如 家属·甲
  relation     TEXT NOT NULL,                -- 患者本人/家属/护工
  id_mask      TEXT NOT NULL DEFAULT '',     -- 脱敏证件号
  phone_masked TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);

-- 陪护申请单
CREATE TABLE IF NOT EXISTS requests (
  id             INTEGER PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,       -- REQ-20260929-001
  applicant_id   INTEGER NOT NULL REFERENCES applicants(id),
  ward_id        INTEGER NOT NULL REFERENCES wards(id),
  spec_required  TEXT NOT NULL,
  planned_start  TEXT NOT NULL,
  planned_end    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'queued',
                 -- queued 队列 / confirmed 已确认锁定时段 / allocated 已分配
                 -- declined 驳回 / completed 已结清 / cancelled 取消
  note           TEXT NOT NULL DEFAULT '',
  decided_by     INTEGER REFERENCES staff(id),
  created_at     TEXT NOT NULL,
  decided_at     TEXT
);

-- 使用时段（申请确认并成功分配床位后生成，锁定床位时段）
CREATE TABLE IF NOT EXISTS rentals (
  id             INTEGER PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,       -- USE-...
  request_id     INTEGER NOT NULL UNIQUE REFERENCES requests(id),
  bed_id         INTEGER NOT NULL REFERENCES beds(id),
  ward_id        INTEGER NOT NULL REFERENCES wards(id),
  applicant_id   INTEGER NOT NULL REFERENCES applicants(id),
  start_at       TEXT NOT NULL,
  planned_end_at TEXT NOT NULL,
  actual_end_at  TEXT,
  status         TEXT NOT NULL DEFAULT 'active', -- active / returned
  isolated_return INTEGER NOT NULL DEFAULT 0,
  finalized      INTEGER NOT NULL DEFAULT 0, -- 押金已结算即不可重开
  finalized_at   TEXT,
  allocated_by   INTEGER NOT NULL REFERENCES staff(id),
  created_at     TEXT NOT NULL
);

-- 临时换床记录
CREATE TABLE IF NOT EXISTS bed_swaps (
  id           INTEGER PRIMARY KEY,
  rental_id    INTEGER NOT NULL REFERENCES rentals(id),
  from_bed_id  INTEGER NOT NULL REFERENCES beds(id),
  to_bed_id    INTEGER NOT NULL REFERENCES beds(id),
  reason       TEXT NOT NULL DEFAULT '',
  nurse_id     INTEGER NOT NULL REFERENCES staff(id),
  created_at   TEXT NOT NULL
);

-- 押金流水（幂等键唯一；进程内模拟适配器）
CREATE TABLE IF NOT EXISTS deposits (
  id          INTEGER PRIMARY KEY,
  idem_key    TEXT NOT NULL UNIQUE,          -- 幂等键
  code        TEXT NOT NULL UNIQUE,          -- DEP-...
  request_id  INTEGER NOT NULL REFERENCES requests(id),
  rental_id   INTEGER REFERENCES rentals(id),
  kind        TEXT NOT NULL,                 -- charge 收取 / refund 退还
                                          -- topup 差异补缴 / deduct 扣除
  amount_fen  INTEGER NOT NULL,              -- 金额（分），正数
  reason      TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'ok',    -- ok / failed
  adapter_ref TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);

-- 归还核验单
CREATE TABLE IF NOT EXISTS return_checks (
  id             INTEGER PRIMARY KEY,
  rental_id      INTEGER NOT NULL UNIQUE REFERENCES rentals(id),
  nurse_id       INTEGER NOT NULL REFERENCES staff(id),
  frame_result     TEXT NOT NULL,            -- ok / damaged / lost
  mattress_result  TEXT NOT NULL,            -- ok / damaged / contaminated / lost
  summary_result  TEXT NOT NULL,             -- pass / fail
  note           TEXT NOT NULL DEFAULT '',
  checked_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

-- 归还核验明细：床架 / 床垫 / 床品 / 配件 四类固定列
CREATE TABLE IF NOT EXISTS return_check_items (
  id           INTEGER PRIMARY KEY,
  check_id     INTEGER NOT NULL REFERENCES return_checks(id),
  category     TEXT NOT NULL,                -- frame / mattress / linen / accessory
  item         TEXT NOT NULL,
  expected_qty INTEGER NOT NULL DEFAULT 0,
  actual_qty   INTEGER NOT NULL DEFAULT 0,
  result       TEXT NOT NULL,                -- ok / missing / damaged / contaminated
  action_reason TEXT NOT NULL DEFAULT '',    -- 异常处理原因
  created_at   TEXT NOT NULL
);

-- 消毒批次
CREATE TABLE IF NOT EXISTS cleaning_batches (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,           -- CLN-...
  ward_id     INTEGER NOT NULL REFERENCES wards(id),
  bed_id      INTEGER NOT NULL REFERENCES beds(id),
  method      TEXT NOT NULL,                  -- 紫外线 / 含氯擦拭 / 臭氧
  contamination INTEGER NOT NULL DEFAULT 0,   -- 是否污染消毒
  status      TEXT NOT NULL DEFAULT 'queued', -- queued/running/completed/failed
  operator_id INTEGER REFERENCES staff(id),
  started_at  TEXT,
  finished_at TEXT,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);

-- 维修单
CREATE TABLE IF NOT EXISTS repairs (
  id         INTEGER PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,           -- RPR-...
  bed_id     INTEGER NOT NULL REFERENCES beds(id),
  issue      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',   -- open / repairing / done
  opened_by  INTEGER REFERENCES staff(id),
  opened_at  TEXT NOT NULL,
  closed_at  TEXT,
  cost_fen   INTEGER NOT NULL DEFAULT 0,
  note       TEXT NOT NULL DEFAULT ''
);

-- 病区调拨
CREATE TABLE IF NOT EXISTS transfers (
  id           INTEGER PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,         -- TRF-...
  from_ward_id INTEGER NOT NULL REFERENCES wards(id),
  to_ward_id   INTEGER NOT NULL REFERENCES wards(id),
  spec         TEXT NOT NULL,
  qty          INTEGER NOT NULL,             -- 交接数量
  from_nurse_id INTEGER REFERENCES staff(id),-- 交出责任人
  to_nurse_id   INTEGER REFERENCES staff(id),-- 接收责任人
  status       TEXT NOT NULL DEFAULT 'proposed', -- proposed/handed_over/received/rejected
  note         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  handed_at    TEXT,
  received_at  TEXT
);
CREATE TABLE IF NOT EXISTS transfer_beds (
  id          INTEGER PRIMARY KEY,
  transfer_id INTEGER NOT NULL REFERENCES transfers(id),
  bed_id      INTEGER NOT NULL REFERENCES beds(id),
  UNIQUE (transfer_id, bed_id)
);

-- 交接照片（本地目录保存，库存相对路径）
CREATE TABLE IF NOT EXISTS photos (
  id          INTEGER PRIMARY KEY,
  ref_type    TEXT NOT NULL,                 -- return / cleaning / repair / transfer
  ref_id      INTEGER NOT NULL,
  filename    TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  mime        TEXT NOT NULL DEFAULT '',
  size        INTEGER NOT NULL DEFAULT 0,
  uploaded_at TEXT NOT NULL
);

-- 统一事件流（使用时间线）
CREATE TABLE IF NOT EXISTS event_log (
  id         INTEGER PRIMARY KEY,
  at         TEXT NOT NULL,
  actor_id   INTEGER REFERENCES staff(id),
  type       TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '{}',
  rental_id  INTEGER,
  bed_id     INTEGER,
  request_id INTEGER,
  ward_id    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_rentals_bed ON rentals(bed_id, status);
CREATE INDEX IF NOT EXISTS idx_events_rental ON event_log(rental_id);
CREATE INDEX IF NOT EXISTS idx_photos_ref ON photos(ref_type, ref_id);

-- 硬约束：一张床位同一时刻只允许存在一个使用中时段（两名护士竞争分配的最终保证）
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_rental_per_bed
  ON rentals(bed_id) WHERE status = 'active';

-- 单号序列
CREATE TABLE IF NOT EXISTS seq (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
`;

function open(dbPath = process.env.CARE_DB_PATH || path.join('data', 'care.db')) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 8000; PRAGMA journal_mode=WAL;');
  db.exec(SCHEMA);
  return db;
}

module.exports = { open, SCHEMA };
