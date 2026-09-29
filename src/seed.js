'use strict';
// 种子数据：生成病区、床位、申请、归还、污染隔离、消毒失败、维修、调拨、押金等全套演示样例
// 用法：node src/seed.js --reset
const fs = require('node:fs');
const path = require('node:path');
const { open } = require('./db');
const { createServices, nowISO } = require('./services');
const { savePhoto, photoDir, placeholderSvg } = require('./photos');

const iso = (d) => d.toISOString();
const hoursAgo = (h) => iso(new Date(Date.now() - h * 3600 * 1000));
const hoursAhead = (h) => iso(new Date(Date.now() + h * 3600 * 1000));

// 床品（发放时各 1 件）
const LINENS = ['床单', '被套', '枕套', '薄被', '枕芯'];
// 固定配件台账
const ACCESSORIES = [
  { item: '呼叫器', expected_qty: 1 },
  { item: '输液架', expected_qty: 1 },
  { item: '脚轮', expected_qty: 4 },
  { item: '护栏', expected_qty: 2 },
];

function resetStorage(dbPath) {
  for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
    try { fs.rmSync(f); } catch { /* ignore */ }
  }
  try { fs.rmSync(photoDir(), { recursive: true, force: true }); } catch { /* ignore */ }
}

function seed(dbPath = process.env.CARE_DB_PATH || path.join('data', 'care.db')) {
  const db = open(dbPath);
  const svc = createServices(db);
  const t = svc.db;
  const ins = (sql, ...p) => t.prepare(sql).run(...p);
  const id = (sql, ...p) => Number(t.prepare(sql).get(...p).id || t.prepare(sql).get(...p).lastInsertRowid);

  // ---------- 病区 ----------
  const wards = {};
  for (const [code, name, building] of [
    ['3W', '呼吸内科三病区', '住院楼A座3层'],
    ['5W', '神经内科五病区', '住院楼A座5层'],
    ['8W', '骨科八病区', '住院楼B座8层'],
  ]) {
    ins('INSERT INTO wards(code,name,building,created_at) VALUES(?,?,?,?)', code, name, building, nowISO());
    wards[code] = t.prepare('SELECT id FROM wards WHERE code=?').get(code).id;
  }

  // ---------- 护理人员与病区权限 ----------
  const staff = {};
  const addStaff = (code, name, title, wardCodes, isAdmin = 0) => {
    ins('INSERT INTO staff(code,name,title,is_admin) VALUES(?,?,?,?)', code, name, title, isAdmin);
    const sid = t.prepare('SELECT id FROM staff WHERE code=?').get(code).id;
    for (const wc of wardCodes) ins('INSERT INTO staff_wards(staff_id,ward_id) VALUES(?,?)', sid, wards[wc]);
    staff[code] = sid;
    return sid;
  };
  addStaff('N-001', '顾总务', '总务护士', ['3W', '5W', '8W'], 1);
  addStaff('N-301', '林岚', '责任护士', ['3W']);
  addStaff('N-302', '周雯', '责任护士', ['3W']);
  addStaff('N-501', '陈默', '责任护士', ['5W']);
  addStaff('N-801', '苏禾', '责任护士', ['8W']);
  const NURSE3 = staff['N-301'], NURSE3B = staff['N-302'], NURSE5 = staff['N-501'],
        NURSE8 = staff['N-801'], ADMIN = staff['N-001'];

  // ---------- 床位（每病区 12 张，每规格各 4 张，全部配件台账） ----------
  // P-01 单摇 / P-02 双摇 / P-03 平板 …（i%3：1 单摇，2 双摇，0 平板）
  const bedSpec = (i) => (['平板床', '单摇床', '双摇床'])[i % 3];
  const bedsOfWard = {};
  for (const wc of ['3W', '5W', '8W']) {
    bedsOfWard[wc] = [];
    for (let i = 1; i <= 12; i++) {
      const code = `P-${String(i).padStart(2, '0')}`;
      ins('INSERT INTO beds(ward_id,code,spec,is_clean,isolated,is_maintenance,created_at) VALUES(?,?,?,1,0,0,?)',
        wards[wc], code, bedSpec(i), nowISO());
      const bid = t.prepare('SELECT id FROM beds WHERE ward_id=? AND code=?').get(wards[wc], code).id;
      for (const a of ACCESSORIES) ins('INSERT INTO bed_accessories(bed_id,item,expected_qty) VALUES(?,?,?)', bid, a.item, a.expected_qty);
      bedsOfWard[wc].push(bid);
    }
  }

  // ---------- 匿名申请人 ----------
  const applicants = {};
  const applicantsData = [
    ['A-1001', '家属·甲', '家属', '3301********1234', '138****0101', '患者匿名 A 组'],
    ['A-1002', '患者本人·乙', '患者本人', '3301********2345', '139****0202', ''],
    ['A-1003', '家属·丙', '家属', '3301********3456', '137****0303', '需夜间陪护'],
    ['A-1004', '护工·丁', '护工', '3301********4567', '136****0404', '持证护工'],
    ['A-1005', '家属·戊', '家属', '3301********5678', '135****0505', '隔离观察'],
    ['A-1006', '家属·己', '家属', '3301********6789', '134****0606', ''],
    ['A-1007', '家属·庚', '家属', '3301********7890', '133****0707', '长租'],
    ['A-1008', '家属·辛', '家属', '3301********8901', '132****0808', ''],
    ['A-1009', '家属·壬', '家属', '3301********9012', '131****0909', '临时换床'],
    ['A-1010', '家属·癸', '家属', '3301********0123', '130****1010', '被驳回示例'],
  ];
  for (const [anon, label, rel, idm, ph, note] of applicantsData) {
    ins(`INSERT INTO applicants(anon_code,label,relation,id_mask,phone_masked,note,created_at) VALUES(?,?,?,?,?,?,?)`,
      anon, label, rel, idm, ph, note, nowISO());
    applicants[anon] = t.prepare('SELECT id FROM applicants WHERE anon_code=?').get(anon).id;
  }

  // 构造标准归还明细：床架/床垫 OK，床品各 1，配件取台账
  const standardItems = (bedId, overrides = {}) => {
    const items = [];
    const fm = (o) => (o ? o.result : 'ok');
    items.push({ category: 'frame', item: '床架', expectedQty: 1, actualQty: 1, result: fm(overrides.frame), actionReason: overrides.frame?.reason || '' });
    items.push({ category: 'mattress', item: '床垫', expectedQty: 1, actualQty: 1, result: fm(overrides.mattress), actionReason: overrides.mattress?.reason || '' });
    for (const l of LINENS) {
      const o = overrides.linens?.[l];
      items.push({ category: 'linen', item: l, expectedQty: 1, actualQty: o ? o.actual : 1, result: o ? o.result : 'ok', actionReason: o?.reason || '' });
    }
    for (const a of svc.accessoriesOfBed(bedId)) {
      const o = overrides.accessories?.[a.item];
      items.push({ category: 'accessory', item: a.item, expectedQty: a.expected_qty, actualQty: o ? o.actual : a.expected_qty, result: o ? o.result : 'ok', actionReason: o?.reason || '' });
    }
    return items;
  };

  // ---------- 病区调拨（先做，占用部分床位形成三种状态） ----------
  // 已完成：3W → 5W 两张平板床（调入后已重新消毒可使用）
  let xfer = svc.proposeTransfer({
    fromWardId: wards['3W'], toWardId: wards['5W'], spec: '平板床',
    bedIds: [bedsOfWard['3W'][2], bedsOfWard['3W'][5]], fromNurseId: NURSE3, toNurseId: NURSE5,
  });
  svc.handOverTransfer(xfer.id, NURSE3);
  xfer = svc.receiveTransfer(xfer.id, NURSE5);
  for (const bcode of ['CLN']) void bcode;
  // 调入产生的批次完成，床位恢复可用
  for (const b0 of svc.listBatches('queued').filter((b) => xfer.beds.some((bb) => bb.id === b.bed_id))) {
    svc.startBatch(b0.id, NURSE5);
    svc.completeBatch(b0.id, NURSE5);
  }
  savePhoto(db, { refType: 'transfer', refId: xfer.id, data: placeholderSvg(`调拨交接 ${xfer.code}`, '3W → 5W · 数量2 · 双方责任人签字', '#2a9d8f'), ext: 'svg' });

  // 交接中：5W → 8W 两张单摇床（已交出待接收，床位被冻结）
  const xferHanding = svc.proposeTransfer({
    fromWardId: wards['5W'], toWardId: wards['8W'], spec: '单摇床',
    bedIds: [bedsOfWard['5W'][0], bedsOfWard['5W'][3]], fromNurseId: NURSE5, toNurseId: NURSE8,
  });
  svc.handOverTransfer(xferHanding.id, NURSE5);

  // 待处理：8W → 3W 两张双摇床（仅提议）
  svc.proposeTransfer({
    fromWardId: wards['8W'], toWardId: wards['3W'], spec: '双摇床',
    bedIds: [bedsOfWard['8W'][1], bedsOfWard['8W'][4]], fromNurseId: NURSE8, toNurseId: NURSE3,
  });

  // ---------- 申请与使用 ----------
  const mkReq = (anon, wc, spec, start = hoursAgo(2), end = hoursAhead(22), note = '') =>
    svc.createRequest({ applicantId: applicants[anon], wardId: wards[wc], specRequired: spec, plannedStart: start, plannedEnd: end, note });

  // 1) 队列中（未确认）
  mkReq('A-1001', '3W', '单摇床', hoursAhead(0), hoursAhead(24), '排队等待床位');

  // 2) 已确认待分配
  const req2 = mkReq('A-1002', '3W', '单摇床', hoursAhead(1), hoursAhead(20));
  svc.confirmRequest(req2.id, NURSE3);

  // 3) 使用中（清洁在架）
  const req3 = mkReq('A-1003', '3W', '平板床', hoursAgo(2), hoursAhead(22), '夜间陪护');
  svc.confirmRequest(req3.id, NURSE3);
  const a3 = svc.allocateBed({ requestId: req3.id, staffId: NURSE3 });

  // 4) 已归还 → 床品缺失（床单/枕套）→ 消毒完成恢复可用 → 已结算（扣赔后退余额）
  const req4 = mkReq('A-1004', '5W', '双摇床', hoursAgo(30), hoursAgo(6));
  svc.confirmRequest(req4.id, NURSE5);
  const a4 = svc.allocateBed({ requestId: req4.id, staffId: NURSE5 });
  const ret4 = svc.recordReturn({
    rentalId: a4.rental.id, staffId: NURSE5,
    frameResult: 'ok', mattressResult: 'ok',
    items: standardItems(a4.rental.bed_id, {
      linens: {
        '床单': { actual: 0, result: 'missing', reason: '床单污损遗失，按价赔偿 40 元' },
        '枕套': { actual: 0, result: 'missing', reason: '枕套缺失，按价赔偿 20 元' },
      },
    }),
    note: '床架、床垫、配件完好；两件床品缺失',
  });
  svc.startBatch(ret4.cleaning.id, NURSE5);
  svc.completeBatch(ret4.cleaning.id, NURSE5);
  svc.settleRental(a4.rental.id, NURSE5, 'seed-4');
  savePhoto(db, { refType: 'return', refId: ret4.check.id, data: placeholderSvg('归还核验 · 床品缺失', '床单×0 / 枕套×0 · 其余完好', '#1f6f8b'), ext: 'svg' });

  // 5) 污染隔离归还 → 消毒失败 → 自动补开（床位保持隔离不可约）
  const req5 = mkReq('A-1005', '5W', '单摇床', hoursAgo(20), hoursAhead(4), '隔离观察');
  svc.confirmRequest(req5.id, NURSE5);
  const a5 = svc.allocateBed({ requestId: req5.id, staffId: NURSE5 });
  const ret5 = svc.recordReturn({
    rentalId: a5.rental.id, staffId: NURSE5,
    frameResult: 'ok', mattressResult: 'contaminated',
    items: standardItems(a5.rental.bed_id, {
      mattress: { result: 'contaminated', reason: '床垫可见体液污染，隔离并按污染流程消毒' },
      linens: { '薄被': { actual: 1, result: 'contaminated', reason: '薄被污染，按医疗织物隔离回收' } },
    }),
    isolated: true, note: '污染隔离，启用含氯擦拭消毒批次',
  });
  svc.startBatch(ret5.cleaning.id, NURSE5);
  const fail5 = svc.failBatch(ret5.cleaning.id, NURSE5, '含氯浓度检测不达标，消毒失败');
  svc.startBatch(fail5.retry.id, NURSE5); // 重试批次进行中，床位仍隔离
  savePhoto(db, { refType: 'cleaning', refId: ret5.cleaning.id, data: placeholderSvg('污染消毒 · 批次失败', '含氯浓度不达标，已补开批次', '#c0392b'), ext: 'svg' });

  // 6) 使用中（8W 平板床）
  const req6 = mkReq('A-1006', '8W', '平板床', hoursAgo(1), hoursAhead(26));
  svc.confirmRequest(req6.id, NURSE8);
  svc.allocateBed({ requestId: req6.id, staffId: NURSE8 });

  // 7) 归还：床架损坏（自动开维修，床位阻断）+ 呼叫器缺失 + 超时 5 小时 → 已结算
  const req7 = mkReq('A-1007', '8W', '双摇床', hoursAgo(32), hoursAgo(6), '长租');
  svc.confirmRequest(req7.id, NURSE8);
  const a7 = svc.allocateBed({ requestId: req7.id, staffId: NURSE8 });
  const ret7 = svc.recordReturn({
    rentalId: a7.rental.id, staffId: NURSE8,
    frameResult: 'damaged', mattressResult: 'ok',
    items: standardItems(a7.rental.bed_id, {
      frame: { result: 'damaged', reason: '床架右侧护栏支臂变形，转维修' },
      accessories: { '呼叫器': { actual: 0, result: 'missing', reason: '呼叫器遗失，按价赔偿 150 元' } },
    }),
    note: '超时归还约 6 小时；床架损坏已开维修单',
  });
  svc.settleRental(a7.rental.id, NURSE8, 'seed-7');
  savePhoto(db, { refType: 'repair', refId: ret7.repair.id, data: placeholderSvg(`维修单 ${ret7.repair.code}`, '床架护栏支臂变形 · 维修中不可预约', '#e67e22'), ext: 'svg' });

  // 8) 归还：多项损坏缺失导致押金不足 → 差异补缴；消毒批次排队中（床位脏）
  const req8 = mkReq('A-1008', '3W', '平板床', hoursAgo(28), hoursAgo(8));
  svc.confirmRequest(req8.id, NURSE3);
  const a8 = svc.allocateBed({ requestId: req8.id, staffId: NURSE3 });
  const ret8 = svc.recordReturn({
    rentalId: a8.rental.id, staffId: NURSE3,
    frameResult: 'ok', mattressResult: 'damaged',
    items: standardItems(a8.rental.bed_id, {
      mattress: { result: 'damaged', reason: '床垫面料多处划破，按价赔偿 60 元' },
      linens: {
        '被套': { actual: 0, result: 'missing', reason: '被套遗失，赔偿 60 元' },
        '薄被': { actual: 0, result: 'missing', reason: '薄被遗失，赔偿 80 元' },
      },
      accessories: { '护栏': { actual: 2, result: 'damaged', reason: '两侧护栏均松动损坏，赔偿 240 元' } },
    }),
    note: '赔偿合计超出押金，需差异补缴',
  });
  svc.settleRental(a8.rental.id, NURSE3, 'seed-8'); // 440 元扣除 → 补缴 140 元
  void ret8;

  // 9) 使用中临时换床（原床完成清洁，新床占用）
  const req9 = mkReq('A-1009', '3W', '单摇床', hoursAgo(3), hoursAhead(20), '空调滴水申请换床');
  svc.confirmRequest(req9.id, NURSE3);
  const a9 = svc.allocateBed({ requestId: req9.id, staffId: NURSE3 });
  // 找另一张可用同规格床
  const swapTarget = svc.bedsByWard(wards['3W']).find((b) => b.allocatable && b.spec === '单摇床' && b.id !== a9.bed.id);
  const swap = svc.swapBed({ rentalId: a9.rental.id, toBedId: swapTarget.id, staffId: NURSE3B, reason: '原床位上方空调滴水，临时换床' });
  svc.startBatch(swap.cleaning.id, NURSE3B);
  svc.completeBatch(swap.cleaning.id, NURSE3B);

  // 10) 被驳回的申请
  const req10 = mkReq('A-1010', '3W', '双摇床', hoursAhead(48), hoursAhead(72));
  svc.declineRequest(req10.id, NURSE3, '申请时段病区无空余双摇床，建议改约');

  // 11) 一张干净床直接登记维修（维修中阻断预约）
  const maintBed = svc.bedsByWard(wards['3W']).find((b) => b.allocatable && b.spec === '双摇床');
  svc.openRepair(maintBed.id, NURSE3, '脚轮制动失灵，待配件更换', 3000);

  return { svc, db, wards, staff, ids: { xferHanding: xferHanding.id } };
}

if (require.main === module) {
  const dbPath = process.env.CARE_DB_PATH || path.join('data', 'care.db');
  if (process.argv.includes('--reset')) resetStorage(dbPath);
  const { db, svc } = seed(dbPath);
  const s = svc.stats();
  console.log('✅ 种子数据已生成');
  console.log(`   病区 3 · 床位 ${s.beds_total}（清洁可用 ${s.beds_clean} · 待消毒 ${s.beds_dirty} · 维修 ${s.beds_maintenance} · 隔离 ${s.beds_isolated} · 占用 ${s.beds_occupied}）`);
  console.log(`   排队/待确认申请 ${s.requests_queued} · 使用中 ${s.rentals_active} · 进行中消毒批次 ${s.cleaning_open}`);
  console.log(`   押金收取/补缴 ¥${(s.deposits_charge_fen / 100).toFixed(2)} · 已退还 ¥${(s.deposits_refund_fen / 100).toFixed(2)}`);
  db.close();
}

module.exports = { seed, resetStorage, LINENS, ACCESSORIES };
