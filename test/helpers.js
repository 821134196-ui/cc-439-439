'use strict';
// 测试夹具：在指定（文件或内存）库中构建最小但完整的演示数据
const fs = require('node:fs');
const { open } = require('../src/db');
const { createServices, nowISO } = require('../src/services');

const ACCESSORIES = [
  { item: '呼叫器', expected_qty: 1 },
  { item: '输液架', expected_qty: 1 },
  { item: '脚轮', expected_qty: 4 },
  { item: '护栏', expected_qty: 2 },
];

function fixture(dbPath = ':memory:') {
  if (dbPath !== ':memory:') {
    for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) { try { fs.rmSync(f); } catch { /* */ } }
  }
  const db = open(dbPath);
  const svc = createServices(db);
  const ins = (sql, ...p) => db.prepare(sql).run(...p);
  const h = 3600 * 1000;
  const t = (offsetH) => new Date(Date.now() + offsetH * h).toISOString();

  const wardIds = {};
  ins("INSERT INTO wards(code,name,building,created_at) VALUES('3W','呼吸内科三病区','A3',?)", nowISO());
  wardIds.w3 = db.prepare("SELECT id FROM wards WHERE code='3W'").get().id;
  ins("INSERT INTO wards(code,name,building,created_at) VALUES('5W','神经内科五病区','A5',?)", nowISO());
  wardIds.w5 = db.prepare("SELECT id FROM wards WHERE code='5W'").get().id;

  // 护士：1 总务（跨病区），2 仅 3W，3 仅 3W，4 仅 5W
  const staffIds = {};
  const addStaff = (code, name, admin, wardId) => {
    ins('INSERT INTO staff(code,name,title,is_admin) VALUES(?,?,?,?)', code, name, '护士', admin);
    const sid = db.prepare('SELECT id FROM staff WHERE code=?').get(code).id;
    if (wardId) ins('INSERT INTO staff_wards(staff_id,ward_id) VALUES(?,?)', sid, wardId);
    staffIds[code] = sid;
    return sid;
  };
  addStaff('N-001', '总务', 1, null);
  addStaff('N-301', '林岚', 0, wardIds.w3);
  addStaff('N-302', '周雯', 0, wardIds.w3);
  addStaff('N-501', '陈默', 0, wardIds.w5);

  // 床位：每病区按规格建若干
  const addBed = (wardId, code, spec, clean = 1) => {
    ins('INSERT INTO beds(ward_id,code,spec,is_clean,isolated,is_maintenance,created_at) VALUES(?,?,?,?,0,0,?)',
      wardId, code, spec, clean, nowISO());
    const bid = db.prepare('SELECT id FROM beds WHERE ward_id=? AND code=?').get(wardId, code).id;
    for (const a of ACCESSORIES) ins('INSERT INTO bed_accessories(bed_id,item,expected_qty) VALUES(?,?,?)', bid, a.item, a.expected_qty);
    return bid;
  };
  // 3W: 两张平板、两张单摇、两张双摇
  const beds3 = {
    flat1: addBed(wardIds.w3, 'P-01', '平板床'),
    flat2: addBed(wardIds.w3, 'P-02', '平板床'),
    single1: addBed(wardIds.w3, 'P-03', '单摇床'),
    single2: addBed(wardIds.w3, 'P-04', '单摇床'),
    double1: addBed(wardIds.w3, 'P-05', '双摇床'),
    dirtyFlat: addBed(wardIds.w3, 'P-06', '平板床', 0),
  };
  const beds5 = { flat1: addBed(wardIds.w5, 'P-01', '平板床') };

  const addApplicant = (anon, label) => {
    ins('INSERT INTO applicants(anon_code,label,relation,id_mask,phone_masked,note,created_at) VALUES(?,?,?,?,?,?,?)',
      anon, label, '家属', '3301********0000', '138****0000', '', nowISO());
    return db.prepare('SELECT id FROM applicants WHERE anon_code=?').get(anon).id;
  };
  const apps = {};
  for (let i = 1; i <= 6; i++) apps['a' + i] = addApplicant('A-200' + i, '家属·' + i);

  const mkReq = (appId, wardId, spec, start = t(-1), end = t(23)) =>
    svc.createRequest({ applicantId: appId, wardId, specRequired: spec, plannedStart: start, plannedEnd: end });

  return { db, svc, ins, wardIds, staffIds, beds3, beds5, apps, mkReq, t, ACCESSORIES };
}

// 标准归还明细（床架/床垫/床品/配件），可覆盖
function standardItems(svc, bedId, override = {}) {
  const items = [
    { category: 'frame', item: '床架', expectedQty: 1, actualQty: 1, result: 'ok', actionReason: '' },
    { category: 'mattress', item: '床垫', expectedQty: 1, actualQty: 1, result: 'ok', actionReason: '' },
  ];
  for (const l of ['床单', '被套', '枕套', '薄被', '枕芯'])
    items.push({ category: 'linen', item: l, expectedQty: 1, actualQty: 1, result: 'ok', actionReason: '' });
  for (const a of svc.accessoriesOfBed(bedId))
    items.push({ category: 'accessory', item: a.item, expectedQty: a.expected_qty, actualQty: a.expected_qty, result: 'ok', actionReason: '' });
  for (const it of items) {
    if (override[it.item]) Object.assign(it, override[it.item]);
  }
  return items;
}

module.exports = { fixture, standardItems, ACCESSORIES };
