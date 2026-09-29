'use strict';
// 领域服务层：全部业务规则在此。事务使用 BEGIN IMMEDIATE 串行化写竞争。
const crypto = require('node:crypto');

// ---------- 常量 ----------
const SPEC = ['平板床', '单摇床', '双摇床'];
const DEPOSIT_FEN = 30000;            // 押金 300 元
const OVERTIME_FEN_PER_HOUR = 200;   // 超时 2 元/小时（演示）
const OVERTIME_GRACE_MIN = 30;       // 宽限 30 分钟
// 床品/配件缺失或损坏赔偿（分）
const ITEM_FEE = {
  '床单': 4000, '被套': 6000, '枕套': 2000, '薄被': 8000, '枕芯': 3000,
  '呼叫器': 15000, '输液架': 5000, '脚轮': 6000, '护栏': 12000,
};
const FRAME_DAMAGE_FEN = 8000;
const MATTRESS_DAMAGE_FEN = 6000;

class DomainError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

const nowISO = () => new Date().toISOString();
const fen = (yuan) => Math.round(yuan * 100);
const yuan = (f) => (f / 100).toFixed(2);

// ---------- 进程内模拟押金适配器 ----------
class InMemoryDepositAdapter {
  constructor() { this.ledger = new Map(); this.failOnce = 0; }
  // 返回模拟网关流水号；幂等由服务层 idem_key 保证，网关自身也去重
  process(idemKey, kind, amountFen) {
    if (this.failOnce > 0) { this.failOnce--; throw new DomainError('GATEWAY_ERROR', '模拟支付网关暂时不可用'); }
    if (this.ledger.has(idemKey)) {
      return { duplicated: true, ref: this.ledger.get(idemKey) };
    }
    const ref = 'PAY-' + crypto.createHash('sha1').update(idemKey).digest('hex').slice(0, 12).toUpperCase();
    this.ledger.set(idemKey, ref);
    return { duplicated: false, ref };
  }
  balance() {
    let charge = 0, refund = 0;
    return { entries: this.ledger.size };
  }
}

function createServices(db, adapter = new InMemoryDepositAdapter()) {
  // ---------- 基础工具 ----------
  const q = (sql, ...p) => db.prepare(sql).get(...p);
  const qa = (sql, ...p) => db.prepare(sql).all(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);

  function nextSeq(name) {
    run('INSERT INTO seq(name,value) VALUES(?,1) ON CONFLICT(name) DO UPDATE SET value=value+1', name);
    return q('SELECT value FROM seq WHERE name=?', name).value;
  }
  const seqCode = (prefix, seqName, pad = 3) =>
    `${prefix}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(nextSeq(seqName)).padStart(pad, '0')}`;

  function logEvent({ type, detail = {}, actorId = null, rentalId = null, bedId = null, requestId = null, wardId = null }) {
    run(
      `INSERT INTO event_log(at,actor_id,type,detail,rental_id,bed_id,request_id,ward_id)
       VALUES(?,?,?,?,?,?,?,?)`,
      nowISO(), actorId, type, JSON.stringify(detail), rentalId, bedId, requestId, wardId
    );
  }

  // ---------- 权限 ----------
  function getStaff(staffId) {
    const s = q('SELECT * FROM staff WHERE id=?', staffId);
    if (!s) throw new DomainError('STAFF_NOT_FOUND', '护理人员不存在');
    return s;
  }
  function wardIdsOf(staffId) {
    return new Set(qa('SELECT ward_id FROM staff_wards WHERE staff_id=?', staffId).map((r) => r.ward_id));
  }
  // 病区权限：管理员可跨病区；其余护士须被授权该病区
  function authorizeWard(staffId, wardId) {
    const s = getStaff(staffId);
    if (s.is_admin) return s;
    if (!wardIdsOf(staffId).has(wardId)) {
      const w = q('SELECT * FROM wards WHERE id=?', wardId);
      throw new DomainError('PERMISSION_DENIED', `护士 ${s.name} 未被授权病区 ${w ? w.name : '#' + wardId}，无法操作`);
    }
    return s;
  }

  // ---------- 查询：床位视图 ----------
  function bedView(bed) {
    const active = q(
      `SELECT r.*, a.label AS applicant_label FROM rentals r
       JOIN applicants a ON a.id=r.applicant_id
       WHERE r.bed_id=? AND r.status='active'`, bed.id
    );
    const openXfer = qa(
      `SELECT t.* FROM transfers t JOIN transfer_beds tb ON tb.transfer_id=t.id
       WHERE tb.bed_id=? AND t.status IN ('proposed','handed_over')`, bed.id
    ).length > 0;
    const openRepairs = qa(`SELECT id FROM repairs WHERE bed_id=? AND status!='done'`, bed.id).length;
    return {
      ...bed,
      occupied: !!active,
      active_rental: active || null,
      in_transfer: openXfer,
      open_repairs: openRepairs,
      is_maintenance: openRepairs > 0 ? 1 : bed.is_maintenance,
      // 可预约：清洁、未隔离、未维修、未占用、不在调拨途中
      allocatable: bed.is_clean === 1 && bed.isolated === 0 && openRepairs === 0 && !active && !openXfer,
    };
  }
  function bedsByWard(wardId) {
    return qa('SELECT * FROM beds WHERE ward_id=? ORDER BY code', wardId).map(bedView);
  }
  function wardMap() {
    return qa('SELECT * FROM wards ORDER BY code').map((w) => ({ ...w, beds: bedsByWard(w.id) }));
  }

  // ---------- 申请人 ----------
  function findApplicantByAnon(anonCode) { return q('SELECT * FROM applicants WHERE anon_code=?', anonCode); }

  // ---------- 申请 ----------
  function createRequest({ applicantId, wardId, specRequired, plannedStart, plannedEnd, note = '' }) {
    if (!SPEC.includes(specRequired)) throw new DomainError('BAD_SPEC', '规格不合法');
    if (new Date(plannedEnd) <= new Date(plannedStart)) throw new DomainError('BAD_TIME', '结束时间须晚于开始时间');
    if (!q('SELECT id FROM applicants WHERE id=?', applicantId)) throw new DomainError('APPLICANT_NOT_FOUND', '申请人不存在');
    if (!q('SELECT id FROM wards WHERE id=?', wardId)) throw new DomainError('WARD_NOT_FOUND', '病区不存在');
    const code = seqCode('REQ', 'req');
    const r = run(
      `INSERT INTO requests(code,applicant_id,ward_id,spec_required,planned_start,planned_end,note,created_at)
       VALUES(?,?,?,?,?,?,?,?)`,
      code, applicantId, wardId, specRequired, plannedStart, plannedEnd, note, nowISO()
    );
    const id = Number(r.lastInsertRowid);
    logEvent({ type: 'request_created', detail: { code, spec: specRequired }, requestId: id, wardId });
    return getRequest(id);
  }
  function getRequest(id) {
    const row = q(
      `SELECT r.*, a.anon_code, a.label AS applicant_label, a.relation, w.name AS ward_name, w.code AS ward_code,
              s.name AS decided_name
       FROM requests r JOIN applicants a ON a.id=r.applicant_id JOIN wards w ON w.id=r.ward_id
       LEFT JOIN staff s ON s.id=r.decided_by WHERE r.id=?`, id
    );
    return row;
  }
  function listRequests(status) {
    const sql = `
      SELECT r.*, a.anon_code, a.label AS applicant_label, w.name AS ward_name, w.code AS ward_code
      FROM requests r JOIN applicants a ON a.id=r.applicant_id JOIN wards w ON w.id=r.ward_id
      ${status ? 'WHERE r.status=?' : ''} ORDER BY r.created_at`;
    return status ? qa(sql, status) : qa(sql);
  }
  // 确认申请 → 锁定时段（进入待分配）
  function confirmRequest(requestId, staffId) {
    const req = getRequest(requestId);
    if (!req) throw new DomainError('REQUEST_NOT_FOUND', '申请不存在');
    authorizeWard(staffId, req.ward_id);
    if (req.status !== 'queued') throw new DomainError('INVALID_STATE', `申请当前为「${statusText(req.status)}」，不能确认`);
    run('UPDATE requests SET status=?, decided_by=?, decided_at=? WHERE id=?', 'confirmed', staffId, nowISO(), requestId);
    logEvent({ type: 'request_confirmed', detail: { code: req.code }, actorId: staffId, requestId, wardId: req.ward_id });
    return getRequest(requestId);
  }
  function declineRequest(requestId, staffId, reason) {
    const req = getRequest(requestId);
    if (!req) throw new DomainError('REQUEST_NOT_FOUND', '申请不存在');
    authorizeWard(staffId, req.ward_id);
    if (!['queued', 'confirmed'].includes(req.status)) throw new DomainError('INVALID_STATE', '当前状态不可驳回');
    run('UPDATE requests SET status=?, decided_by=?, decided_at=?, note=? WHERE id=?',
      'declined', staffId, nowISO(), (reason || '') + (req.note ? ' | ' + req.note : ''), requestId);
    logEvent({ type: 'request_declined', detail: { code: req.code, reason }, actorId: staffId, requestId, wardId: req.ward_id });
    return getRequest(requestId);
  }

  // ---------- 床位分配（并发核心） ----------
  function pickCandidateBed(wardId, spec, plannedStart, plannedEnd, txDb = db) {
    const beds = txDb.prepare('SELECT * FROM beds WHERE ward_id=? AND spec=? ORDER BY code').all(wardId, spec);
    for (const bed of beds) {
      if (bed.is_clean !== 1 || bed.isolated === 1 || bed.is_maintenance === 1) continue;
      const active = txDb.prepare(`SELECT id FROM rentals WHERE bed_id=? AND status='active'`).get(bed.id);
      if (active) continue;
      const inXfer = txDb.prepare(
        `SELECT 1 FROM transfer_beds tb JOIN transfers t ON t.id=tb.transfer_id
         WHERE tb.bed_id=? AND t.status IN ('proposed','handed_over')`).get(bed.id);
      if (inXfer) continue;
      // 时段重叠（即便历史 active 也检查规划窗口）
      const overlap = txDb.prepare(
        `SELECT id FROM rentals WHERE bed_id=? AND status='active'
         AND NOT (? >= planned_end_at OR ? <= start_at)`).get(bed.id, plannedStart, plannedEnd);
      if (overlap) continue;
      return bed;
    }
    return null;
  }

  // 分配指定床位；两名护士并发时依赖 uniq_active_rental_per_bed 只允许一人成功
  function allocateBed({ requestId, bedId = null, staffId }) {
    const staff = getStaff(staffId);
    db.exec('BEGIN IMMEDIATE');
    try {
      const req = getRequest(requestId);
      if (!req) throw new DomainError('REQUEST_NOT_FOUND', '申请不存在');
      authorizeWard(staffId, req.ward_id);
      if (!['confirmed', 'queued'].includes(req.status)) {
        throw new DomainError('INVALID_STATE', `申请「${req.code}」当前为「${statusText(req.status)}」，不能分配`);
      }
      let bed;
      if (bedId == null) {
        bed = pickCandidateBed(req.ward_id, req.spec_required, req.planned_start, req.planned_end);
        if (!bed) throw new DomainError('NO_AVAILABLE_BED', `病区内没有可用的${req.spec_required}（清洁/未隔离/未维修/未占用）`);
      } else {
        bed = q('SELECT * FROM beds WHERE id=?', bedId);
        if (!bed) throw new DomainError('BED_NOT_FOUND', '床位不存在');
        if (bed.ward_id !== req.ward_id) throw new DomainError('PERMISSION_DENIED', '床位与申请不在同一病区');
        if (bed.spec !== req.spec_required) throw new DomainError('SPEC_MISMATCH', `该床为${bed.spec}，申请需要${req.spec_required}`);
        if (bed.is_maintenance === 1 || q('SELECT 1 FROM repairs WHERE bed_id=? AND status!=?', bed.id, 'done')) {
          throw new DomainError('BED_IN_MAINTENANCE', '该床位维修中，不能预约');
        }
        if (bed.isolated === 1) throw new DomainError('BED_ISOLATED', '该床位污染隔离中，不能预约');
        if (bed.is_clean !== 1) throw new DomainError('BED_NOT_CLEAN', '该床位清洁批次未完成，不能预约');
        const active = q(`SELECT id FROM rentals WHERE bed_id=? AND status='active'`, bed.id);
        if (active) throw new DomainError('BED_TAKEN', '该床位已被占用');
        const inXfer = q(
          `SELECT 1 FROM transfer_beds tb JOIN transfers t ON t.id=tb.transfer_id
           WHERE tb.bed_id=? AND t.status IN ('proposed','handed_over')`, bed.id);
        if (inXfer) throw new DomainError('BED_IN_TRANSFER', '该床位正在病区调拨交接中');
      }

      const code = seqCode('USE', 'rental');
      let rentalId;
      try {
        const r = run(
          `INSERT INTO rentals(code,request_id,bed_id,ward_id,applicant_id,start_at,planned_end_at,status,allocated_by,created_at)
           VALUES(?,?,?,?,?,?,?, 'active',?,?)`,
          code, requestId, bed.id, req.ward_id, req.applicant_id, req.planned_start, req.planned_end, staffId, nowISO()
        );
        rentalId = Number(r.lastInsertRowid);
      } catch (e) {
        if (String(e.code).includes('CONSTRAINT')) throw new DomainError('BED_TAKEN', '该床位刚刚已被另一名护士分配成功（竞争失败）', { cause: e });
        throw e;
      }
      run('UPDATE beds SET current_rental_id=? WHERE id=?', rentalId, bed.id);
      run("UPDATE requests SET status='allocated', decided_by=COALESCE(decided_by,?) WHERE id=?", staffId, requestId);

      // 收取押金（幂等键：request+charge）
      const dep = postDepositInternal({
        idemKey: `charge:req:${requestId}`, requestId, rentalId, kind: 'charge',
        amountFen: DEPOSIT_FEN, reason: '陪护床使用押金',
      });

      logEvent({ type: 'allocated', detail: { code, bed: bed.code, deposit: dep.code }, actorId: staffId, rentalId, bedId: bed.id, requestId, wardId: req.ward_id });
      db.exec('COMMIT');
      return { rental: getRental(rentalId), deposit: dep, bed: bedView(q('SELECT * FROM beds WHERE id=?', bed.id)) };
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  function getRental(id) {
    return q(
      `SELECT r.*, b.code AS bed_code, b.spec, w.name AS ward_name, w.code AS ward_code,
              a.anon_code, a.label AS applicant_label
       FROM rentals r JOIN beds b ON b.id=r.bed_id JOIN wards w ON w.id=r.ward_id
       JOIN applicants a ON a.id=r.applicant_id WHERE r.id=?`, id
    );
  }
  function listRentals(status) {
    const sql = `
      SELECT r.*, b.code AS bed_code, w.code AS ward_code, a.label AS applicant_label
      FROM rentals r JOIN beds b ON b.id=r.bed_id JOIN wards w ON w.id=r.ward_id
      JOIN applicants a ON a.id=r.applicant_id ${status ? 'WHERE r.status=?' : ''} ORDER BY r.created_at DESC`;
    return status ? qa(sql, status) : qa(sql);
  }

  // ---------- 临时换床 ----------
  function swapBed({ rentalId, toBedId, staffId, reason = '' }) {
    const staff = getStaff(staffId);
    db.exec('BEGIN IMMEDIATE');
    try {
      const rental = getRental(rentalId);
      if (!rental) throw new DomainError('RENTAL_NOT_FOUND', '使用单不存在');
      if (rental.status !== 'active') throw new DomainError('INVALID_STATE', '使用单不在使用中，不能换床');
      authorizeWard(staffId, rental.ward_id);
      const to = q('SELECT * FROM beds WHERE id=?', toBedId);
      if (!to) throw new DomainError('BED_NOT_FOUND', '目标床位不存在');
      if (to.ward_id !== rental.ward_id) throw new DomainError('PERMISSION_DENIED', '临时换床限本病区');
      if (to.spec !== rental.spec) throw new DomainError('SPEC_MISMATCH', '目标床位规格不一致');
      if (to.id === rental.bed_id) throw new DomainError('BAD_INPUT', '目标床位与当前床位相同');
      if (to.is_clean !== 1) throw new DomainError('BED_NOT_CLEAN', '目标床位未完成清洁批次');
      if (to.isolated === 1) throw new DomainError('BED_ISOLATED', '目标床位污染隔离中');
      if (q('SELECT 1 FROM repairs WHERE bed_id=? AND status!=?', to.id, 'done'))
        throw new DomainError('BED_IN_MAINTENANCE', '目标床位维修中');
      if (q(`SELECT 1 FROM rentals WHERE bed_id=? AND status='active'`, to.id))
        throw new DomainError('BED_TAKEN', '目标床位已被占用');

      const fromId = rental.bed_id;
      run('INSERT INTO bed_swaps(rental_id,from_bed_id,to_bed_id,reason,nurse_id,created_at) VALUES(?,?,?,?,?,?)',
        rentalId, fromId, to.id, reason, staffId, nowISO());
      run('UPDATE rentals SET bed_id=? WHERE id=?', to.id, rentalId);
      run('UPDATE beds SET current_rental_id=NULL, is_clean=0 WHERE id=?', fromId);
      run('UPDATE beds SET current_rental_id=? WHERE id=?', rentalId, to.id);
      // 原床位进入清洁
      const batch = createCleaningBatchInternal(fromId, rental.ward_id, staffId, '含氯擦拭', 0, '临时换床后清洁');
      logEvent({
        type: 'bed_swapped', actorId: staffId, rentalId, wardId: rental.ward_id,
        detail: { from: rental.bed_code, to: to.code, reason, cleaning: batch.code },
      });
      db.exec('COMMIT');
      return { rental: getRental(rentalId), cleaning: batch };
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  // ---------- 消毒批次 ----------
  function createCleaningBatch(bedId, staffId, method, contamination = 0, note = '') {
    db.exec('BEGIN IMMEDIATE');
    try {
      const bed = q('SELECT * FROM beds WHERE id=?', bedId);
      if (!bed) throw new DomainError('BED_NOT_FOUND', '床位不存在');
      authorizeWard(staffId, bed.ward_id);
      const batch = createCleaningBatchInternal(bedId, bed.ward_id, staffId, method, contamination, note);
      db.exec('COMMIT');
      return batch;
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  function createCleaningBatchInternal(bedId, wardId, staffId, method, contamination, note) {
    const code = seqCode('CLN', 'clean');
    run(
      `INSERT INTO cleaning_batches(code,ward_id,bed_id,method,contamination,status,operator_id,note,created_at)
       VALUES(?,?,?,?,?, 'queued', ?,?,?)`,
      code, wardId, bedId, method, contamination, staffId, note, nowISO()
    );
    const id = Number(q('SELECT last_insert_rowid() AS x').x);
    // 新建批次时床位视为未清洁；污染批次立即置隔离，常规批次保留原隔离标记
    run('UPDATE beds SET is_clean=0 WHERE id=?', bedId);
    if (contamination) run('UPDATE beds SET isolated=1 WHERE id=?', bedId);
    logEvent({ type: 'cleaning_queued', detail: { code, method, contamination }, actorId: staffId, bedId, wardId });
    return getBatch(id);
  }
  function getBatch(id) {
    return q(
      `SELECT c.*, b.code AS bed_code, w.name AS ward_name, w.code AS ward_code, s.name AS operator_name
       FROM cleaning_batches c JOIN beds b ON b.id=c.bed_id JOIN wards w ON w.id=c.ward_id
       LEFT JOIN staff s ON s.id=c.operator_id WHERE c.id=?`, id
    );
  }
  function listBatches(status) {
    const sql = `
      SELECT c.*, b.code AS bed_code, w.code AS ward_code, s.name AS operator_name
      FROM cleaning_batches c JOIN beds b ON b.id=c.bed_id JOIN wards w ON w.id=c.ward_id
      LEFT JOIN staff s ON s.id=c.operator_id ${status ? 'WHERE c.status=?' : ''} ORDER BY c.created_at DESC`;
    return status ? qa(sql, status) : qa(sql);
  }
  function startBatch(batchId, staffId) {
    const b0 = getBatch(batchId);
    if (!b0) throw new DomainError('BATCH_NOT_FOUND', '消毒批次不存在');
    authorizeWard(staffId, b0.ward_id);
    if (b0.status !== 'queued') throw new DomainError('INVALID_STATE', '仅排队中的批次可开始');
    run("UPDATE cleaning_batches SET status='running', operator_id=?, started_at=? WHERE id=?", staffId, nowISO(), batchId);
    logEvent({ type: 'cleaning_started', actorId: staffId, bedId: b0.bed_id, wardId: b0.ward_id, detail: { code: b0.code } });
    return getBatch(batchId);
  }
  // 完成消毒 → 床位重新清洁可用（维修仍独立阻断）
  function completeBatch(batchId, staffId) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const b0 = getBatch(batchId);
      if (!b0) throw new DomainError('BATCH_NOT_FOUND', '消毒批次不存在');
      authorizeWard(staffId, b0.ward_id);
      if (b0.status !== 'running') throw new DomainError('INVALID_STATE', '仅进行中的批次可完成');
      run("UPDATE cleaning_batches SET status='completed', finished_at=? WHERE id=?", nowISO(), batchId);
      run('UPDATE beds SET is_clean=1, isolated=0 WHERE id=?', b0.bed_id);
      logEvent({ type: 'cleaning_completed', actorId: staffId, bedId: b0.bed_id, wardId: b0.ward_id, detail: { code: b0.code } });
      db.exec('COMMIT');
      return getBatch(batchId);
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  // 消毒失败：记录，床位保持不可用，须另开批次重试
  function failBatch(batchId, staffId, reason) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const b0 = getBatch(batchId);
      if (!b0) throw new DomainError('BATCH_NOT_FOUND', '消毒批次不存在');
      authorizeWard(staffId, b0.ward_id);
      if (b0.status !== 'running') throw new DomainError('INVALID_STATE', '仅进行中的批次可登记失败');
      run("UPDATE cleaning_batches SET status='failed', finished_at=?, note=? WHERE id=?", nowISO(), reason || '', batchId);
      run('UPDATE beds SET is_clean=0, isolated=1 WHERE id=?', b0.bed_id);
      // 自动补开一个待执行批次
      const retry = createCleaningBatchInternal(b0.bed_id, b0.ward_id, staffId, b0.method, b0.contamination, '前序批次失败：' + (reason || ''));
      logEvent({ type: 'cleaning_failed', actorId: staffId, bedId: b0.bed_id, wardId: b0.ward_id, detail: { code: b0.code, reason, retry: retry.code } });
      db.exec('COMMIT');
      return { failed: getBatch(batchId), retry };
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  // ---------- 维修 ----------
  function openRepair(bedId, staffId, issue, costFen = 0) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const bed = q('SELECT * FROM beds WHERE id=?', bedId);
      if (!bed) throw new DomainError('BED_NOT_FOUND', '床位不存在');
      authorizeWard(staffId, bed.ward_id);
      const active = q(`SELECT id FROM rentals WHERE bed_id=? AND status='active'`, bedId);
      if (active) throw new DomainError('BED_OCCUPIED', '床位使用中，须先归还再登记维修');
      const code = seqCode('RPR', 'repair');
      run(`INSERT INTO repairs(code,bed_id,issue,status,opened_by,opened_at,cost_fen) VALUES(?,?,?, 'open', ?,?,?)`,
        code, bedId, issue, staffId, nowISO(), costFen);
      const id = Number(q('SELECT last_insert_rowid() AS x').x);
      run('UPDATE beds SET is_maintenance=1, is_clean=0 WHERE id=?', bedId);
      logEvent({ type: 'repair_opened', actorId: staffId, bedId, wardId: bed.ward_id, detail: { code, issue } });
      db.exec('COMMIT');
      return getRepair(id);
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  function getRepair(id) {
    return q(`SELECT rp.*, b.code AS bed_code, w.code AS ward_code, s.name AS opened_name
              FROM repairs rp JOIN beds b ON b.id=rp.bed_id JOIN wards w ON w.id=b.ward_id
              LEFT JOIN staff s ON s.id=rp.opened_by WHERE rp.id=?`, id);
  }
  function listRepairs(openOnly = false) {
    return qa(`SELECT rp.*, b.code AS bed_code, w.code AS ward_code FROM repairs rp
               JOIN beds b ON b.id=rp.bed_id JOIN wards w ON w.id=b.ward_id
               ${openOnly ? "WHERE rp.status!='done'" : ''} ORDER BY rp.opened_at DESC`);
  }
  function closeRepair(repairId, staffId, note = '', costFen = null) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const rp = getRepair(repairId);
      if (!rp) throw new DomainError('REPAIR_NOT_FOUND', '维修单不存在');
      authorizeWard(staffId, q('SELECT ward_id FROM beds WHERE id=?', rp.bed_id).ward_id);
      if (rp.status === 'done') throw new DomainError('INVALID_STATE', '维修单已关闭');
      run('UPDATE repairs SET status=?, closed_at=?, note=?, cost_fen=COALESCE(?,cost_fen) WHERE id=?',
        'done', nowISO(), note, costFen, repairId);
      const stillOpen = q(`SELECT COUNT(*) c FROM repairs WHERE bed_id=? AND status!='done'`, rp.bed_id).c;
      run('UPDATE beds SET is_maintenance=? WHERE id=?', stillOpen, rp.bed_id);
      logEvent({ type: 'repair_closed', actorId: staffId, bedId: rp.bed_id, detail: { code: rp.code } });
      db.exec('COMMIT');
      return getRepair(repairId);
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  // ---------- 归还核验 ----------
  // items: [{category:'frame'|'mattress'|'linen'|'accessory', item, expectedQty, actualQty, result, actionReason}]
  function recordReturn({ rentalId, staffId, frameResult, mattressResult, items = [], isolated = false, note = '' }) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const rental = getRental(rentalId);
      if (!rental) throw new DomainError('RENTAL_NOT_FOUND', '使用单不存在');
      if (rental.status !== 'active') throw new DomainError('INVALID_STATE', '该使用单已归还，不能重复核验');
      if (rental.finalized) throw new DomainError('ALREADY_FINALIZED', '订单已结算关闭，不能重开');
      authorizeWard(staffId, rental.ward_id);

      // 配件台账数量校验：实际数量不得为负，且不应超过应有数量（缺失用更小值表达）
      for (const it of items) {
        if (!['frame', 'mattress', 'linen', 'accessory'].includes(it.category))
          throw new DomainError('BAD_ITEM', `未知核验列：${it.category}`);
        if (it.actualQty < 0 || it.expectedQty < 0) throw new DomainError('BAD_QTY', '数量不能为负');
        if (!['ok', 'missing', 'damaged', 'contaminated'].includes(it.result))
          throw new DomainError('BAD_RESULT', `异常结果不合法：${it.result}`);
        if (it.result !== 'ok' && !it.actionReason) throw new DomainError('REASON_REQUIRED', `异常项「${it.item}」必须填写处理原因`);
      }

      const summary = computeSummary(frameResult, mattressResult, items);
      const code = rental.code;
      run(
        `INSERT INTO return_checks(rental_id,nurse_id,frame_result,mattress_result,summary_result,note,checked_at,created_at)
         VALUES(?,?,?,?,?,?,?,?)`,
        rentalId, staffId, frameResult, mattressResult, summary, note, nowISO(), nowISO()
      );
      const checkId = Number(q('SELECT last_insert_rowid() AS x').x);
      const insItem = db.prepare(
        `INSERT INTO return_check_items(check_id,category,item,expected_qty,actual_qty,result,action_reason,created_at)
         VALUES(?,?,?,?,?,?,?,?)`
      );
      for (const it of items) {
        insItem.run(checkId, it.category, it.item, it.expectedQty, it.actualQty, it.result, it.actionReason || '', nowISO());
      }

      // 床位结束占用；进入清洁；污染则隔离
      run('UPDATE rentals SET status=?, actual_end_at=?, isolated_return=? WHERE id=?', 'returned', nowISO(), isolated ? 1 : 0, rentalId);
      run('UPDATE beds SET current_rental_id=NULL, is_clean=0, isolated=? WHERE id=?', isolated ? 1 : 0, rental.bed_id);

      // 床架损坏 → 自动开维修（维修阻断再次预约）
      let repair = null;
      if (frameResult === 'damaged' || frameResult === 'lost') {
        const rcode = seqCode('RPR', 'repair');
        run(`INSERT INTO repairs(code,bed_id,issue,status,opened_by,opened_at) VALUES(?,?,?, 'open', ?,?)`,
          rcode, rental.bed_id, '归还核验：床架' + (frameResult === 'lost' ? '缺失' : '损坏'), staffId, nowISO());
        const rid = Number(q('SELECT last_insert_rowid() AS x').x);
        run('UPDATE beds SET is_maintenance=1 WHERE id=?', rental.bed_id);
        repair = getRepair(rid);
      }
      // 消毒批次（污染用含氯擦拭 + contamination 标记）
      const method = isolated || mattressResult === 'contaminated' || items.some((i) => i.result === 'contaminated')
        ? '含氯擦拭' : '紫外线';
      const cont = isolated || mattressResult === 'contaminated' || items.some((i) => i.result === 'contaminated') ? 1 : 0;
      const batch = createCleaningBatchInternal(rental.bed_id, rental.ward_id, staffId, method, cont,
        cont ? '归还发现污染，隔离消毒' : '归还后常规消毒');

      // 超时事件
      const ot = overtimeInfo(rental.planned_end_at, nowISO());
      if (ot.overtime) {
        logEvent({ type: 'overtime', actorId: staffId, rentalId, bedId: rental.bed_id, wardId: rental.ward_id,
          detail: { planned_end: rental.planned_end_at, actual_end: nowISO(), overtime_min: ot.minutes, fee_fen: ot.feeFen } });
      }

      logEvent({ type: 'returned', actorId: staffId, rentalId, bedId: rental.bed_id, wardId: rental.ward_id,
        detail: { code, summary, isolated: cont, overtime_min: ot.minutes, cleaning: batch.code, repair: repair?.code || null } });
      db.exec('COMMIT');
      return { check: getCheck(checkId), items: listCheckItems(checkId), cleaning: batch, repair, overtime: ot };
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  function computeSummary(frameResult, mattressResult, items) {
    if (frameResult !== 'ok') return 'fail';
    if (mattressResult !== 'ok') return 'fail';
    if (items.some((i) => i.result !== 'ok')) return 'fail';
    return 'pass';
  }
  function overtimeInfo(plannedEnd, actualEnd) {
    const diffMin = Math.floor((new Date(actualEnd) - new Date(plannedEnd)) / 60000);
    const chargeable = Math.max(0, diffMin - OVERTIME_GRACE_MIN);
    const hours = Math.ceil(chargeable / 60);
    return { minutes: Math.max(0, diffMin), overtime: chargeable > 0, feeFen: hours * OVERTIME_FEN_PER_HOUR };
  }
  function getCheck(id) {
    return q(`SELECT c.*, r.code AS rental_code, b.code AS bed_code, s.name AS nurse_name,
                     w.code AS ward_code
              FROM return_checks c
              JOIN rentals r ON r.id=c.rental_id JOIN beds b ON b.id=r.bed_id
              JOIN staff s ON s.id=c.nurse_id JOIN wards w ON w.id=r.ward_id
              WHERE c.id=?`, id);
  }
  function listCheckItems(checkId) {
    return qa('SELECT * FROM return_check_items WHERE check_id=? ORDER BY category,id', checkId);
  }
  function getCheckByRental(rentalId) {
    const c = q('SELECT * FROM return_checks WHERE rental_id=?', rentalId);
    if (!c) return null;
    return { ...c, items: listCheckItems(c.id) };
  }
  function listChecks() {
    return qa(`SELECT c.*, r.code AS rental_code, b.code AS bed_code, s.name AS nurse_name
               FROM return_checks c JOIN rentals r ON r.id=c.rental_id JOIN beds b ON b.id=r.bed_id
               JOIN staff s ON s.id=c.nurse_id ORDER BY c.checked_at DESC`);
  }

  // ---------- 押金 ----------
  // 幂等：同一 idem_key 仅入账一次（无论重复调用多少次）
  function postDepositInternal({ idemKey, requestId, rentalId = null, kind, amountFen, reason = '' }) {
    const exist = q('SELECT * FROM deposits WHERE idem_key=?', idemKey);
    if (exist) return { ...exist, duplicated: true };
    if (amountFen <= 0) throw new DomainError('BAD_AMOUNT', '金额必须为正');
    const { ref } = adapter.process(idemKey, kind, amountFen); // 网关异常会使整笔事务回滚
    const code = seqCode('DEP', 'deposit', 4);
    run(`INSERT INTO deposits(idem_key,code,request_id,rental_id,kind,amount_fen,reason,status,adapter_ref,created_at)
         VALUES(?,?,?,?,?,?,?, 'ok', ?,?)`,
      idemKey, code, requestId, rentalId, kind, amountFen, reason, ref, nowISO());
    return { ...q('SELECT * FROM deposits WHERE code=?', code), duplicated: false };
  }
  function postDeposit(args, staffId) {
    const req = getRequest(args.requestId);
    if (!req) throw new DomainError('REQUEST_NOT_FOUND', '申请不存在');
    authorizeWard(staffId, req.ward_id);
    db.exec('BEGIN IMMEDIATE');
    let out;
    try {
      out = postDepositInternal(args);
      logEvent({ type: 'deposit_' + args.kind, actorId: staffId, requestId: args.requestId, rentalId: args.rentalId,
        wardId: req.ward_id, detail: { amount_fen: args.amountFen, reason: args.reason, duplicated: out.duplicated } });
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return out;
  }
  function listDeposits() {
    return qa(`SELECT d.*, r.code AS request_code, b.code AS bed_code, rt.code AS rental_code
               FROM deposits d JOIN requests r ON r.id=d.request_id
               LEFT JOIN rentals rt ON rt.id=d.rental_id LEFT JOIN beds b ON b.id=rt.bed_id
               ORDER BY d.created_at DESC`);
  }

  // 计算应扣款项。床架/床垫以汇总结果为准计一次；床品与配件按明细逐项计。
  function settlementCharges(rentalId, check) {
    const charges = [];
    if (check) {
      for (const it of (check.items || []).filter((x) => x.category === 'linen' || x.category === 'accessory')) {
        if (it.result === 'missing') {
          const missing = it.expected_qty - it.actual_qty;
          if (missing > 0) charges.push({ label: `床品/配件缺失赔偿·${it.item}×${missing}`, fen: missing * (ITEM_FEE[it.item] || 2000) });
        } else if (it.result === 'damaged') {
          const damaged = Math.max(it.expected_qty, it.actual_qty);
          charges.push({ label: `损坏赔偿·${it.item}×${damaged}`, fen: damaged * (ITEM_FEE[it.item] || 2000) });
        } else if (it.result === 'contaminated') {
          charges.push({ label: `污染处置费·${it.item}`, fen: 1000 });
        }
      }
      if (check.frame_result === 'damaged') charges.push({ label: '床架损坏维修分摊', fen: FRAME_DAMAGE_FEN });
      if (check.frame_result === 'lost') charges.push({ label: '床架缺失赔偿', fen: 12000 });
      if (check.mattress_result === 'damaged') charges.push({ label: '床垫损坏赔偿', fen: MATTRESS_DAMAGE_FEN });
      if (check.mattress_result === 'contaminated') charges.push({ label: '床垫污染处置费', fen: 1000 });
    }
    return charges;
  }

  // 结算：核验完成后计算差异；结算后订单不可重开，迟到归还不能重开
  function settleRental(rentalId, staffId, idemKey) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const rental = getRental(rentalId);
      if (!rental) throw new DomainError('RENTAL_NOT_FOUND', '使用单不存在');
      authorizeWard(staffId, rental.ward_id);
      if (rental.status !== 'returned') throw new DomainError('INVALID_STATE', '须先完成归还核验才能结算');
      if (rental.finalized) throw new DomainError('ALREADY_FINALIZED', '订单已结算；迟到归还不可重开订单，需另走线下登记');

      const check = getCheckByRental(rentalId);
      const charges = settlementCharges(rentalId, check);
      const ot = overtimeInfo(rental.planned_end_at, rental.actual_end_at);
      if (ot.overtime) charges.push({ label: `超时使用费（${ot.minutes}分钟）`, fen: ot.feeFen });

      const depositRow = q(`SELECT * FROM deposits WHERE request_id=? AND kind='charge' ORDER BY id LIMIT 1`, rental.request_id);
      const deposited = depositRow ? depositRow.amount_fen : DEPOSIT_FEN;
      const deduct = charges.reduce((s, c) => s + c.fen, 0);

      const results = [];
      if (deduct > deposited) {
        // 押金不足 → 差异补缴
        results.push(postDepositInternal({
          idemKey: `topup:rental:${rentalId}:${idemKey}`, requestId: rental.request_id, rentalId,
          kind: 'topup', amountFen: deduct - deposited, reason: '押金不足，差异补缴：' + charges.map((c) => c.label).join('、'),
        }));
      } else if (deduct > 0) {
        results.push(postDepositInternal({
          idemKey: `deduct:rental:${rentalId}:${idemKey}`, requestId: rental.request_id, rentalId,
          kind: 'deduct', amountFen: deduct, reason: '押金扣除：' + charges.map((c) => c.label).join('、'),
        }));
      }
      const refundFen = Math.max(0, deposited - deduct);
      if (refundFen > 0) {
        results.push(postDepositInternal({
          idemKey: `refund:rental:${rentalId}:${idemKey}`, requestId: rental.request_id, rentalId,
          kind: 'refund', amountFen: refundFen, reason: deduct > 0 ? '扣除后退还余额' : '无损全额退还',
        }));
      }
      run('UPDATE rentals SET finalized=1, finalized_at=? WHERE id=?', nowISO(), rentalId);
      run("UPDATE requests SET status='completed' WHERE id=?", rental.request_id);
      logEvent({ type: 'settled', actorId: staffId, rentalId, bedId: rental.bed_id, wardId: rental.ward_id,
        detail: { deposited, deduct, refund: refundFen, charges } });
      db.exec('COMMIT');
      return {
        rental: getRental(rentalId), deposited_fen: deposited, deduct_fen: deduct,
        refund_fen: refundFen, charges, deposits: results.map((d) => ({ ...d, duplicated: !!d.duplicated })),
      };
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  // ---------- 病区调拨（数量 + 双责任人两阶段交接） ----------
  function proposeTransfer({ fromWardId, toWardId, spec, bedIds, fromNurseId, toNurseId }) {
    if (fromWardId === toWardId) throw new DomainError('BAD_INPUT', '调出与调入病区不能相同');
    const from = authorizeWard(fromNurseId, fromWardId);
    const to = authorizeWard(toNurseId, toWardId);
    if (bedIds.length === 0) throw new DomainError('BAD_QTY', '交接数量至少为 1');
    db.exec('BEGIN IMMEDIATE');
    try {
      const beds = bedIds.map((id) => q('SELECT * FROM beds WHERE id=?', id));
      for (const b of beds) {
        if (!b) throw new DomainError('BED_NOT_FOUND', '床位不存在');
        if (b.ward_id !== fromWardId) throw new DomainError('PERMISSION_DENIED', '床位不属于调去病区');
        if (b.spec !== spec) throw new DomainError('SPEC_MISMATCH', '调拨床位规格必须一致');
        if (q(`SELECT 1 FROM rentals WHERE bed_id=? AND status='active'`, b.id))
          throw new DomainError('BED_OCCUPIED', `床位 ${b.code} 使用中，不能调拨`);
        if (q(`SELECT 1 FROM repairs WHERE bed_id=? AND status!='done'`, b.id))
          throw new DomainError('BED_IN_MAINTENANCE', `床位 ${b.code} 维修中，不能调拨`);
        if (q(`SELECT 1 FROM transfer_beds tb JOIN transfers t ON t.id=tb.transfer_id
               WHERE tb.bed_id=? AND t.status IN ('proposed','handed_over')`, b.id))
          throw new DomainError('BED_IN_TRANSFER', `床位 ${b.code} 已在调拨中`);
      }
      const code = seqCode('TRF', 'transfer');
      run(`INSERT INTO transfers(code,from_ward_id,to_ward_id,spec,qty,from_nurse_id,to_nurse_id,status,created_at)
           VALUES(?,?,?,?,?,?,?, 'proposed',?)`,
        code, fromWardId, toWardId, spec, beds.length, fromNurseId, toNurseId, nowISO());
      const id = Number(q('SELECT last_insert_rowid() AS x').x);
      const ins = db.prepare('INSERT INTO transfer_beds(transfer_id,bed_id) VALUES(?,?)');
      for (const b of beds) ins.run(id, b.id);
      logEvent({ type: 'transfer_proposed', actorId: fromNurseId, wardId: fromWardId,
        detail: { code, qty: beds.length, spec, to_ward: toWardId, from_nurse: from.name, to_nurse: to.name } });
      db.exec('COMMIT');
      return getTransfer(id);
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  function getTransfer(id) {
    const t = q(`SELECT t.*, wf.name AS from_ward_name, wt.name AS to_ward_name,
                        sf.name AS from_nurse_name, st.name AS to_nurse_name
                 FROM transfers t JOIN wards wf ON wf.id=t.from_ward_id JOIN wards wt ON wt.id=t.to_ward_id
                 LEFT JOIN staff sf ON sf.id=t.from_nurse_id LEFT JOIN staff st ON st.id=t.to_nurse_id WHERE t.id=?`, id);
    if (!t) return null;
    t.beds = qa(`SELECT b.* FROM transfer_beds tb JOIN beds b ON b.id=tb.bed_id WHERE tb.transfer_id=? ORDER BY b.code`, id);
    return t;
  }
  function listTransfers() {
    return qa(`SELECT t.*, wf.name AS from_ward_name, wt.name AS to_ward_name,
                      sf.name AS from_nurse_name, st.name AS to_nurse_name
               FROM transfers t JOIN wards wf ON wf.id=t.from_ward_id JOIN wards wt ON wt.id=t.to_ward_id
               LEFT JOIN staff sf ON sf.id=t.from_nurse_id LEFT JOIN staff st ON st.id=t.to_nurse_id
               ORDER BY t.created_at DESC`);
  }
  function handOverTransfer(transferId, staffId) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const t = getTransfer(transferId);
      if (!t) throw new DomainError('TRANSFER_NOT_FOUND', '调拨单不存在');
      const s = getStaff(staffId);
      if (!s.is_admin && t.from_nurse_id !== staffId)
        throw new DomainError('PERMISSION_DENIED', '仅调出责任人可执行交出');
      if (t.status !== 'proposed') throw new DomainError('INVALID_STATE', '仅已提议的调拨可交出');
      run("UPDATE transfers SET status='handed_over', handed_at=? WHERE id=?", nowISO(), transferId);
      logEvent({ type: 'transfer_handed_over', actorId: staffId, wardId: t.from_ward_id,
        detail: { code: t.code, qty: t.qty, responsible: s.name } });
      db.exec('COMMIT');
      return getTransfer(transferId);
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  function receiveTransfer(transferId, staffId) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const t = getTransfer(transferId);
      if (!t) throw new DomainError('TRANSFER_NOT_FOUND', '调拨单不存在');
      const s = getStaff(staffId);
      if (!s.is_admin && t.to_nurse_id !== staffId)
        throw new DomainError('PERMISSION_DENIED', '仅接收责任人可确认接收');
      authorizeWard(staffId, t.to_ward_id);
      if (t.status !== 'handed_over') throw new DomainError('INVALID_STATE', '须先由调出方交出，才能接收');
      // 正式变更归属；床位在新病区重新编号（避免床号冲突），并保持未清洁，需重新消毒后方可使用
      for (const b of t.beds) {
        const used = new Set(qa('SELECT code FROM beds WHERE ward_id=?', t.to_ward_id).map((x) => x.code));
        let n = 1, newCode;
        do { newCode = `P-${String(n).padStart(2, '0')}`; n++; } while (used.has(newCode));
        run('UPDATE beds SET ward_id=?, code=?, is_clean=0, current_rental_id=NULL WHERE id=?', t.to_ward_id, newCode, b.id);
        createCleaningBatchInternal(b.id, t.to_ward_id, staffId, '紫外线', 0, `调入病区重新编号为 ${newCode} 后消毒`);
      }
      run("UPDATE transfers SET status='received', received_at=? WHERE id=?", nowISO(), transferId);
      logEvent({ type: 'transfer_received', actorId: staffId, wardId: t.to_ward_id,
        detail: { code: t.code, qty: t.qty, responsible: s.name } });
      db.exec('COMMIT');
      return getTransfer(transferId);
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  function rejectTransfer(transferId, staffId, reason) {
    const t = getTransfer(transferId);
    if (!t) throw new DomainError('TRANSFER_NOT_FOUND', '调拨单不存在');
    const s = getStaff(staffId);
    if (!s.is_admin && t.from_nurse_id !== staffId && t.to_nurse_id !== staffId)
      throw new DomainError('PERMISSION_DENIED', '仅交接双方责任人可驳回');
    if (!['proposed', 'handed_over'].includes(t.status)) throw new DomainError('INVALID_STATE', '当前状态不可驳回');
    run("UPDATE transfers SET status='rejected', note=? WHERE id=?", reason || '', transferId);
    logEvent({ type: 'transfer_rejected', actorId: staffId, wardId: t.from_ward_id,
      detail: { code: t.code, reason, by: s.name } });
    return getTransfer(transferId);
  }

  // ---------- 时间线 ----------
  function timeline({ rentalId = null, limit = 200 } = {}) {
    const rows = rentalId
      ? qa(`SELECT e.*, s.name AS actor_name FROM event_log e LEFT JOIN staff s ON s.id=e.actor_id
            WHERE e.rental_id=? ORDER BY e.at, e.id LIMIT ?`, rentalId, limit)
      : qa(`SELECT e.*, s.name AS actor_name FROM event_log e LEFT JOIN staff s ON s.id=e.actor_id
            ORDER BY e.at DESC, e.id DESC LIMIT ?`, limit);
    return rows.map((r) => ({ ...r, detailObj: safeJson(r.detail) }));
  }
  function stats() {
    const one = (sql, ...p) => q(sql, ...p).c;
    return {
      beds_total: one('SELECT COUNT(*) c FROM beds'),
      beds_clean: one('SELECT COUNT(*) c FROM beds WHERE is_clean=1 AND is_maintenance=0'),
      beds_dirty: one('SELECT COUNT(*) c FROM beds WHERE is_clean=0'),
      beds_maintenance: one('SELECT COUNT(*) c FROM beds WHERE is_maintenance=1 OR id IN (SELECT bed_id FROM repairs WHERE status!=? )', 'done'),
      beds_isolated: one('SELECT COUNT(*) c FROM beds WHERE isolated=1'),
      beds_occupied: one("SELECT COUNT(*) c FROM beds WHERE current_rental_id IS NOT NULL"),
      requests_queued: one("SELECT COUNT(*) c FROM requests WHERE status IN ('queued','confirmed')"),
      rentals_active: one("SELECT COUNT(*) c FROM rentals WHERE status='active'"),
      cleaning_open: one("SELECT COUNT(*) c FROM cleaning_batches WHERE status IN ('queued','running')"),
      deposits_charge_fen: one("SELECT COALESCE(SUM(amount_fen),0) c FROM deposits WHERE kind IN ('charge','topup')"),
      deposits_refund_fen: one("SELECT COALESCE(SUM(amount_fen),0) c FROM deposits WHERE kind='refund'"),
    };
  }

  return {
    db, adapter,
    SPEC, DEPOSIT_FEN, ITEM_FEE, OVERTIME_FEN_PER_HOUR, OVERTIME_GRACE_MIN,
    authorizeWard, getStaff, wardIdsOf,
    bedView, bedsByWard, wardMap,
    findApplicantByAnon, listApplicants: () => qa('SELECT * FROM applicants ORDER BY id'),
    listWards: () => qa('SELECT * FROM wards ORDER BY code'),
    createRequest, getRequest, listRequests, confirmRequest, declineRequest,
    allocateBed, pickCandidateBed, getRental, listRentals, swapBed,
    createCleaningBatch, startBatch, completeBatch, failBatch, getBatch, listBatches,
    openRepair, closeRepair, getRepair, listRepairs,
    recordReturn, getCheckByRental, listCheckItems, listChecks, overtimeInfo,
    postDeposit, listDeposits, settleRental,
    proposeTransfer, handOverTransfer, receiveTransfer, rejectTransfer, getTransfer, listTransfers,
    timeline, stats,
    accessoriesOfBed: (bedId) => qa('SELECT * FROM bed_accessories WHERE bed_id=? ORDER BY id', bedId),
  };
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
function statusText(s) {
  return ({ queued: '排队中', confirmed: '已确认待分配', allocated: '已分配', declined: '已驳回', completed: '已结清', cancelled: '已取消' })[s] || s;
}

module.exports = { createServices, DomainError, InMemoryDepositAdapter, fen, yuan, nowISO, statusText, SPEC };
