'use strict';
// HTTP 服务（Node 内置 http，零依赖）。含会话（当前操作员）、表单与 multipart 照片上传。
const http = require('node:http');
const { URL } = require('node:url');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { open } = require('./db');
const { createServices, DomainError, nowISO } = require('./services');
const view = require('./view');
const photos = require('./photos');
const { seed, resetStorage } = require('./seed');

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.CARE_DB_PATH || path.join('data', 'care.db');

const db = open(DB_PATH);
const svc = createServices(db);

// ---------- 简易会话 ----------
const sessions = new Map(); // token -> staffId
function getStaffId(req) {
  const m = /(?:^|;\s*)care_token=([^;]+)/.exec(req.headers.cookie || '');
  if (m && sessions.has(m[1])) return sessions.get(m[1]);
  const def = db.prepare("SELECT id FROM staff WHERE code='N-301'").get();
  return def ? def.id : db.prepare('SELECT id FROM staff ORDER BY id LIMIT 1').get().id;
}
function setSession(res, staffId) {
  const token = crypto.randomBytes(12).toString('hex');
  sessions.set(token, staffId);
  res.setHeader('Set-Cookie', `care_token=${token}; Path=/; HttpOnly`);
}

// ---------- body 解析 ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function parseForm(buffer, contentType = '') {
  if (contentType.includes('application/json')) return JSON.parse(buffer.toString('utf8') || '{}');
  if (contentType.includes('multipart/form-data')) return parseMultipart(buffer, contentType);
  const params = new URLSearchParams(buffer.toString('utf8'));
  const out = {};
  for (const [k, v] of params) {
    if (k.endsWith('[]')) { (out[k] ||= []).push(v); }
    else if (out[k] !== undefined) { if (!Array.isArray(out[k])) out[k] = [out[k]]; out[k].push(v); }
    else out[k] = v;
  }
  return out;
}
function parseMultipart(buffer, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const b = '--' + (boundary[1] || boundary[2]);
  const out = { __files: {} };
  let start = buffer.indexOf(b);
  while (start !== -1) {
    start += b.length;
    if (buffer[start] === 0x2d) break; // closing --
    const headerEnd = buffer.indexOf('\r\n\r\n', start);
    if (headerEnd === -1) break;
    const headers = buffer.slice(start, headerEnd).toString('utf8');
    let dataStart = headerEnd + 4;
    let next = buffer.indexOf(b, dataStart);
    if (next === -1) break;
    let dataEnd = next - 2; // strip CRLF
    const nameM = /name="([^"]+)"/.exec(headers);
    const fileM = /filename="([^"]*)"/.exec(headers);
    if (nameM) {
      const name = nameM[1];
      if (fileM && fileM[1]) {
        const ctM = /Content-Type:\s*([^\r\n]+)/i.exec(headers);
        out.__files[name] = {
          filename: path.basename(fileM[1]),
          data: buffer.slice(dataStart, dataEnd),
          mime: (ctM ? ctM[1] : 'application/octet-stream').trim(),
        };
      } else {
        out[name] = buffer.slice(dataStart, dataEnd).toString('utf8');
      }
    }
    start = next;
  }
  return out;
}

// ---------- HTTP 辅助 ----------
function send(res, status, html, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(html);
}
function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}
function back(req, res, err, fallback = '/') {
  const ref = req.headers.referer;
  if (ref) {
    const u = new URL(ref);
    if (err) u.searchParams.set('err', encodeURIComponent(err.message));
    redirect(res, u.pathname + u.search);
  } else redirect(res, fallback + (err ? `?err=${encodeURIComponent(err.message)}` : ''));
}

function baseCtx(req) {
  const staffId = getStaffId(req);
  const staff = svc.getStaff(staffId);
  return {
    staff,
    staffList: db.prepare('SELECT * FROM staff ORDER BY is_admin DESC, id').all(),
    wardAuth: svc.wardIdsOf(staffId),
    dbFile: DB_PATH,
  };
}
function render(req, res, active, title, body, extra = {}) {
  const u = new URL(req.url, 'http://x');
  const flash = {};
  if (u.searchParams.get('ok')) flash.ok = u.searchParams.get('ok');
  if (u.searchParams.get('err')) flash.err = decodeURIComponent(u.searchParams.get('err'));
  const ctx = { ...baseCtx(req), flash, ...extra };
  send(res, 200, view.layout(active, title, body, ctx));
}
function wrap(fn) {
  return async (req, res, p) => {
    try { await fn(req, res, p); }
    catch (e) {
      if (e instanceof DomainError) return back(req, res, e);
      console.error(e);
      back(req, res, new Error('服务器内部错误：' + e.message));
    }
  };
}

// ---------- 页面数据组装 ----------
function allocatableByWard() {
  const m = new Map();
  for (const w of svc.listWards()) m.set(w.id, svc.bedsByWard(w.id).filter((b) => b.allocatable));
  return m;
}

const pages = {
  map: wrap((req, res) => {
    const ctx = baseCtx(req);
    render(req, res, '/', '病区床位图', view.mapView({ ...ctx, wards: svc.wardMap() }));
  }),

  bed: wrap((req, res, p) => {
    const ctx = baseCtx(req);
    const b0 = svc.db.prepare('SELECT * FROM beds WHERE id=?').get(p.id);
    if (!b0) return send(res, 404, '床位不存在');
    const b = svc.bedView(b0);
    const ward = svc.db.prepare('SELECT * FROM wards WHERE id=?').get(b.ward_id);
    const repairIds = svc.listRepairs().filter((r) => r.bed_id === b.id).map((r) => r.id);
    const batchIds = svc.listBatches().filter((c) => c.bed_id === b.id).map((c) => c.id);
    const allPhotos = photos.listPhotos(db).filter(
      (x) => (x.ref_type === 'repair' && repairIds.includes(x.ref_id)) ||
             (x.ref_type === 'cleaning' && batchIds.includes(x.ref_id))
    );
    const rental = b.occupied ? svc.getRental(b.current_rental_id) : null;
    render(req, res, '/', `床位 ${ward.code}-${b.code}`, view.bedDetail({
      ...ctx, b, ward,
      accessories: svc.accessoriesOfBed(b.id),
      repairs: svc.listRepairs().filter((r) => r.bed_id === b.id),
      batches: svc.listBatches().filter((c) => c.bed_id === b.id),
      rental, photos: allPhotos,
      canAct: ctx.staff.is_admin || ctx.wardAuth.has(b.ward_id),
    }));
  }),

  requests: wrap((req, res) => {
    const ctx = baseCtx(req);
    const requests = svc.listRequests().map((r) => ({
      ...r,
      rental_id: svc.db.prepare('SELECT id FROM rentals WHERE request_id=?').get(r.id)?.id || null,
    }));
    const u = new URL(req.url, 'http://x');
    const newForm = u.searchParams.get('new') !== '0';
    render(req, res, '/requests', '申请队列', view.requestsView({
      ...ctx, requests, allocatableByWard: allocatableByWard(),
    }) + newRequestPanel(ctx), { scripts: view.TRANSFER_JS });
  }),

  rentals: wrap((req, res) => {
    const ctx = baseCtx(req);
    render(req, res, '/rentals', '使用时间线', view.rentalsView({
      ...ctx, rentals: svc.listRentals(), timeline: svc.timeline({ limit: 60 }),
    }));
  }),

  rental: wrap((req, res, p) => {
    const ctx = baseCtx(req);
    const r = svc.getRental(p.id);
    if (!r) return send(res, 404, '使用单不存在');
    const check = svc.getCheckByRental(r.id);
    const swaps = svc.db.prepare(
      `SELECT sw.*, bf.code AS from_code, bt.code AS to_code, s.name AS nurse_name
       FROM bed_swaps sw JOIN beds bf ON bf.id=sw.from_bed_id JOIN beds bt ON bt.id=sw.to_bed_id
       JOIN staff s ON s.id=sw.nurse_id WHERE sw.rental_id=? ORDER BY sw.id`).all(r.id);
    const swapTargets = svc.bedsByWard(r.ward_id).filter(
      (b) => b.allocatable && b.spec === r.spec && b.id !== r.bed_id);
    const photoRows = photos.listPhotos(db).filter((x) => {
      if (x.ref_type === 'return' && (x.ref_id === r.id || (check && x.ref_id === check.id))) return true;
      return false;
    });
    render(req, res, '/rentals', `使用单 ${r.code}`, view.rentalDetail({
      ...ctx, r, can: ctx.staff.is_admin || ctx.wardAuth.has(r.ward_id),
      check, events: svc.timeline({ rentalId: r.id }), swaps, swapTargets, photos: photoRows,
    }));
  }),

  returns: wrap((req, res) => {
    const ctx = baseCtx(req);
    render(req, res, '/returns', '归还核验', view.returnsView({
      ...ctx,
      active: svc.listRentals('active'),
      checks: svc.listChecks(),
    }));
  }),

  returnForm: wrap((req, res, p) => {
    const ctx = baseCtx(req);
    const r = svc.getRental(p.id);
    if (!r) return send(res, 404, '使用单不存在');
    render(req, res, '/returns', `归还核验 ${r.code}`, view.returnForm({
      ...ctx, r, accessories: svc.accessoriesOfBed(r.bed_id),
      can: ctx.staff.is_admin || ctx.wardAuth.has(r.ward_id),
    }), { scripts: view.TRANSFER_JS });
  }),

  cleaning: wrap((req, res) => {
    const ctx = baseCtx(req);
    render(req, res, '/cleaning', '消毒批次', view.cleaningView({ ...ctx, batches: svc.listBatches() }));
  }),

  deposits: wrap((req, res) => {
    const ctx = baseCtx(req);
    const u = new URL(req.url, 'http://x');
    let settleHint = '';
    if (u.searchParams.get('settle')) {
      const r = svc.getRental(Number(u.searchParams.get('settle')));
      if (r) settleHint = `使用单 ${r.code} 已归还，请在下方「待结算」中核对并结算押金。`;
    }
    render(req, res, '/deposits', '押金结算', view.depositsView({
      ...ctx,
      deposits: svc.listDeposits(),
      unsettled: svc.listRentals('returned').filter((r) => !r.finalized),
      settleHint,
    }));
  }),

  transfers: wrap((req, res) => {
    const ctx = baseCtx(req);
    const transfers = svc.listTransfers().map((t) => ({ ...t, beds: svc.getTransfer(t.id).beds }));
    render(req, res, '/transfers', '病区调拨', view.transfersView({
      ...ctx, transfers, wards: svc.listWards(),
    }), { scripts: view.TRANSFER_JS });
  }),
};

function newRequestPanel(ctx) {
  const applicants = svc.listApplicants();
  const wards = svc.listWards();
  const canAny = ctx.staff.is_admin || ctx.wardAuth.size > 0;
  if (!canAny) return '';
  const local = (d) => {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  return `<div class="panel mt"><h3>新建陪护申请（演示）</h3><form method="post" action="/requests" class="inline">
    <select name="applicantId">${applicants.map((a) => `<option value="${a.id}">${a.anon_code} ${a.label}</option>`).join('')}</select>
    <select name="wardId">${wards.map((w) => `<option value="${w.id}" ${ctx.wardAuth.has(w.id) ? '' : ''}>${w.code} ${w.name}</option>`).join('')}</select>
    <select name="spec"><option>平板床</option><option>单摇床</option><option>双摇床</option></select>
    <label>开始 <input type="datetime-local" name="start" value="${local(new Date(Date.now() + 3600e3))}" required></label>
    <label>结束 <input type="datetime-local" name="end" value="${local(new Date(Date.now() + 25 * 3600e3))}" required></label>
    <input name="note" placeholder="备注（可选）">
    <button class="btn teal small">提交申请</button></form></div>`;
}

// ---------- POST 动作 ----------
const actions = {
  switchStaff: wrap(async (req, res) => {
    const f = parseForm(await readBody(req), req.headers['content-type']);
    setSession(res, Number(f.staffId));
    redirect(res, req.headers.referer || '/');
  }),

  bedRepair: wrap(async (req, res, p) => {
    const f = parseForm(await readBody(req), req.headers['content-type']);
    svc.openRepair(p.id, getStaffId(req), String(f.issue || '').trim());
    redirect(res, `/beds/${p.id}?ok=${encodeURIComponent('已登记维修，该床位立即停止预约')}`);
  }),
  bedCleaning: wrap(async (req, res, p) => {
    const f = parseForm(await readBody(req), req.headers['content-type']);
    svc.createCleaningBatch(p.id, getStaffId(req), f.method || '紫外线', f.contamination ? 1 : 0, '床位页手工开批次');
    redirect(res, `/beds/${p.id}?ok=${encodeURIComponent('消毒批次已建立，完成前床位不可预约')}`);
  }),
  repairClose: wrap(async (req, res, p) => {
    const f = parseForm(await readBody(req), req.headers['content-type']);
    const r = svc.closeRepair(p.id, getStaffId(req), String(f.note || ''));
    redirect(res, `/beds/${r.bed_id}?ok=${encodeURIComponent('维修单已关闭；床位完成清洁后可重新预约')}`);
  }),

  requestCreate: wrap(async (req, res) => {
    const f = parseForm(await readBody(req), req.headers['content-type']);
    const r = svc.createRequest({
      applicantId: Number(f.applicantId), wardId: Number(f.wardId), specRequired: f.spec,
      plannedStart: new Date(f.start).toISOString(), plannedEnd: new Date(f.end).toISOString(),
      note: String(f.note || ''),
    });
    // 创建申请同样受病区权限约束（在事务之外补一道）
    svc.authorizeWard(getStaffId(req), r.ward_id);
    redirect(res, `/requests?ok=${encodeURIComponent(`申请 ${r.code} 已进入队列`)}`);
  }),
  requestConfirm: wrap(async (req, res, p) => {
    const r = svc.confirmRequest(p.id, getStaffId(req));
    redirect(res, `/requests?ok=${encodeURIComponent(`申请 ${r.code} 已确认，规划时段锁定`)}`);
  }),
  requestDecline: wrap(async (req, res, p) => {
    const f = parseForm(await readBody(req), req.headers['content-type']);
    const r = svc.declineRequest(p.id, getStaffId(req), String(f.reason || ''));
    redirect(res, `/requests?ok=${encodeURIComponent(`申请 ${r.code} 已驳回`)}`);
  }),
  requestAllocate: wrap(async (req, res, p) => {
    const f = parseForm(await readBody(req), req.headers['content-type']);
    const out = svc.allocateBed({ requestId: p.id, bedId: f.bedId ? Number(f.bedId) : null, staffId: getStaffId(req) });
    redirect(res, `/rentals/${out.rental.id}?ok=${encodeURIComponent(`分配成功：床位 ${out.bed.code}，押金 ${out.deposit.code} 已收取`)}`);
  }),

  swap: wrap(async (req, res, p) => {
    const f = parseForm(await readBody(req), req.headers['content-type']);
    const out = svc.swapBed({ rentalId: p.id, toBedId: Number(f.toBedId), staffId: getStaffId(req), reason: String(f.reason || '') });
    redirect(res, `/rentals/${p.id}?ok=${encodeURIComponent(`已换至床位；原床位进入消毒批次 ${out.cleaning.code}`)}`);
  }),
  settle: wrap(async (req, res, p) => {
    const out = svc.settleRental(p.id, getStaffId(req), crypto.randomBytes(6).toString('hex'));
    redirect(res, `/deposits?ok=${encodeURIComponent(
      `结算完成：收取/补缴 ¥${(out.deposited_fen / 100).toFixed(2)}，扣除 ¥${(out.deduct_fen / 100).toFixed(2)}，退还 ¥${(out.refund_fen / 100).toFixed(2)}；订单已关闭`)}`);
  }),

  returnSubmit: wrap(async (req, res, p) => {
    const f = parseForm(await readBody(req), req.headers['content-type']);
    const r = svc.getRental(p.id);
    const items = [];
    const pushItem = (category, item, expKeyBase) => {};
    for (const [key, val] of Object.entries(f)) {
      if (key.startsWith('__')) continue;
      const m = /^(frame|mattress|linen|accessory)__(.+?)__(exp|act|res|reason)$/.exec(key);
      if (!m) continue;
      const [, category, item, field] = m;
      const base = `${category}__${item}`;
      let row = items.find((x) => x._base === base);
      if (!row) { row = { _base: base, category, item, expectedQty: 0, actualQty: 0, result: 'ok', actionReason: '' }; items.push(row); }
      if (field === 'exp') row.expectedQty = Number(val);
      if (field === 'act') row.actualQty = Number(val);
      if (field === 'res') row.result = val;
      if (field === 'reason') row.actionReason = String(val || '');
    }
    // 床架/床垫以汇总结果补成明细行（三固定列展示需要）
    items.push({ category: 'frame', item: '床架', expectedQty: 1, actualQty: f.frameResult === 'lost' ? 0 : 1,
      result: f.frameResult, actionReason: String(f.frameReason || '') });
    items.push({ category: 'mattress', item: '床垫', expectedQty: 1, actualQty: f.mattressResult === 'lost' ? 0 : 1,
      result: f.mattressResult, actionReason: String(f.mattressReason || '') });

    const out = svc.recordReturn({
      rentalId: p.id, staffId: getStaffId(req),
      frameResult: f.frameResult, mattressResult: f.mattressResult,
      items, isolated: !!f.isolated, note: String(f.note || ''),
    });
    redirect(res, `/rentals/${p.id}?ok=${encodeURIComponent(
      `归还核验完成（${out.check.summary_result === 'pass' ? '通过' : '有异常已处置'}）；消毒批次 ${out.cleaning.code}${out.repair ? `，维修单 ${out.repair.code}` : ''}${out.overtime.overtime ? `，超时 ${out.overtime.minutes} 分钟` : ''}`)}`);
  }),

  cleanStart: wrap(async (req, res, p) => { svc.startBatch(p.id, getStaffId(req)); redirect(res, req.headers.referer || '/cleaning'); }),
  cleanComplete: wrap(async (req, res, p) => {
    const b = svc.completeBatch(p.id, getStaffId(req));
    redirect(res, `/cleaning?ok=${encodeURIComponent(`批次 ${b.code} 完成，床位 ${b.bed_code} 恢复清洁可用`)}`);
  }),
  cleanFail: wrap(async (req, res, p) => {
    const f = parseForm(await readBody(req), req.headers['content-type']);
    const out = svc.failBatch(p.id, getStaffId(req), String(f.reason || ''));
    redirect(res, `/cleaning?ok=${encodeURIComponent(`批次 ${out.failed.code} 失败已记录，补开批次 ${out.retry.code}，床位保持不可用`)}`);
  }),

  transferCreate: wrap(async (req, res) => {
    const f = parseForm(await readBody(req), req.headers['content-type']);
    const bedIds = Array.isArray(f.bedId) ? f.bedId.map(Number) : (f.bedId ? [Number(f.bedId)] : []);
    const t = svc.proposeTransfer({
      fromWardId: Number(f.fromWardId), toWardId: Number(f.toWardId), spec: f.spec,
      bedIds, fromNurseId: getStaffId(req), toNurseId: Number(f.toNurseId),
    });
    redirect(res, `/transfers?ok=${encodeURIComponent(`调拨 ${t.code} 已提议，数量 ${t.qty}，待交出人确认`)}`);
  }),
  transferHandover: wrap(async (req, res, p) => {
    const t = svc.handOverTransfer(p.id, getStaffId(req));
    redirect(res, `/transfers?ok=${encodeURIComponent(`调拨 ${t.code} 已交出 ${t.qty} 张，等待接收责任人确认`)}`);
  }),
  transferReceive: wrap(async (req, res, p) => {
    const t = svc.receiveTransfer(p.id, getStaffId(req));
    redirect(res, `/transfers?ok=${encodeURIComponent(`调拨 ${t.code} 已接收，床位转入新病区并重新编号，待消毒后可用`)}`);
  }),
  transferReject: wrap(async (req, res, p) => {
    const f = parseForm(await readBody(req), req.headers['content-type']);
    const t = svc.rejectTransfer(p.id, getStaffId(req), String(f.reason || ''));
    redirect(res, `/transfers?ok=${encodeURIComponent(`调拨 ${t.code} 已驳回`)}`);
  }),

  photoUpload: wrap(async (req, res, p) => {
    const f = parseForm(await readBody(req), req.headers['content-type']);
    const file = f.__files && f.__files.photo;
    if (!file || !file.data.length) throw new DomainError('NO_FILE', '未选择照片文件');
    const ext = (path.extname(file.filename).replace('.', '') || 'bin').slice(0, 5).replace(/[^a-z0-9]/gi, '');
    const row = photos.savePhoto(db, { refType: p.refType, refId: p.refId, data: file.data, ext: ext || 'bin', mime: file.mime });
    redirect(res, (req.headers.referer || '/') + (req.headers.referer && req.headers.referer.includes('?') ? '&' : '?') +
      `ok=${encodeURIComponent(`照片已保存到本地目录（${row.filename}）`)}`);
  }),
};

// ---------- 路由 ----------
const routes = [
  ['GET', /^\/$/, pages.map],
  ['GET', /^\/beds\/(\d+)$/, pages.bed],
  ['GET', /^\/requests$/, pages.requests],
  ['GET', /^\/rentals$/, pages.rentals],
  ['GET', /^\/rentals\/(\d+)$/, pages.rental],
  ['GET', /^\/returns$/, pages.returns],
  ['GET', /^\/returns\/(\d+)$/, pages.returnForm],
  ['GET', /^\/cleaning$/, pages.cleaning],
  ['GET', /^\/deposits$/, pages.deposits],
  ['GET', /^\/transfers$/, pages.transfers],

  ['POST', /^\/switch-staff$/, actions.switchStaff],
  ['POST', /^\/beds\/(\d+)\/repair$/, actions.bedRepair],
  ['POST', /^\/beds\/(\d+)\/cleaning$/, actions.bedCleaning],
  ['POST', /^\/repairs\/(\d+)\/close$/, actions.repairClose],
  ['POST', /^\/requests$/, actions.requestCreate],
  ['POST', /^\/requests\/(\d+)\/confirm$/, actions.requestConfirm],
  ['POST', /^\/requests\/(\d+)\/decline$/, actions.requestDecline],
  ['POST', /^\/requests\/(\d+)\/allocate$/, actions.requestAllocate],
  ['POST', /^\/rentals\/(\d+)\/swap$/, actions.swap],
  ['POST', /^\/rentals\/(\d+)\/settle$/, actions.settle],
  ['POST', /^\/returns\/(\d+)$/, actions.returnSubmit],
  ['POST', /^\/cleaning\/(\d+)\/start$/, actions.cleanStart],
  ['POST', /^\/cleaning\/(\d+)\/complete$/, actions.cleanComplete],
  ['POST', /^\/cleaning\/(\d+)\/fail$/, actions.cleanFail],
  ['POST', /^\/transfers$/, actions.transferCreate],
  ['POST', /^\/transfers\/(\d+)\/(handover|receive|reject)$/, (r, q, p) =>
    ({ handover: actions.transferHandover, receive: actions.transferReceive, reject: actions.transferReject }[p[2]])(r, q, p)],
  ['POST', /^\/photos\/(return|cleaning|repair|transfer)\/(\d+)$/, actions.photoUpload],
];

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const pathname = u.pathname;

    if (pathname === '/api/allocatable') {
      const wardId = Number(u.searchParams.get('wardId'));
      const spec = u.searchParams.get('spec') || '';
      const list = svc.bedsByWard(wardId).filter((b) => b.allocatable && (!spec || b.spec === spec));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(list.map((b) => ({ id: b.id, code: b.code, spec: b.spec }))));
    }
    const pm = /^\/photo\/(\d+)$/.exec(pathname);
    if (req.method === 'GET' && pm) {
      const row = db.prepare('SELECT * FROM photos WHERE id=?').get(Number(pm[1]));
      if (!row) { res.writeHead(404); return res.end('not found'); }
      const file = photos.absolutePath(row);
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end('file missing'); }
      res.writeHead(200, { 'Content-Type': row.mime || 'application/octet-stream' });
      return fs.createReadStream(file).pipe(res);
    }

    for (const [method, re, handler] of routes) {
      if (req.method !== method) continue;
      const m = re.exec(pathname);
      if (m) return handler(req, res, { id: m[1] ? Number(m[1]) : null, refType: m[1], refId: Number(m[2]), 0: m[0], 1: m[1], 2: m[2] });
    }
    send(res, 404, '<h1>404</h1><p>页面不存在。</p>');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, '<h1>500</h1><pre>' + String(e.message).replace(/[<>&]/g, '') + '</pre>');
  }
});

if (require.main === module) {
  // 单条本地启动命令：库为空时自动生成申请、归还、污染隔离等全套演示样例
  const wardCount = db.prepare('SELECT COUNT(*) c FROM wards').get().c;
  if (wardCount === 0) {
    console.log('⏳ 首次启动，正在生成演示数据（申请 / 归还 / 隔离 / 消毒 / 维修 / 调拨 / 押金）…');
    seed(DB_PATH); // 使用独立连接播种并提交，本连接在 WAL 下立即可见
  }
  server.listen(PORT, () => {
    console.log(`✅ 陪护床位与消毒交接系统已启动： http://localhost:${PORT}`);
    console.log(`   数据库 ${DB_PATH} · 照片目录 ${photos.photoDir()}`);
  });
}

module.exports = { server, parseForm };
