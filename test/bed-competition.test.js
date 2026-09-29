'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const { fixture } = require('./helpers');

// ---- 1) 业务规则：同一张床第二次分配被唯一索引/占用校验拒绝 ----
test('同一床位连续两次分配：仅第一次成功', () => {
  const { svc, beds3, staffIds, apps, wardIds, mkReq } = fixture();
  const r1 = mkReq(apps.a1, wardIds.w3, '平板床');
  svc.confirmRequest(r1.id, staffIds['N-301']);
  const a1 = svc.allocateBed({ requestId: r1.id, bedId: beds3.flat1, staffId: staffIds['N-301'] });
  assert.equal(a1.bed.id, beds3.flat1);

  const r2 = mkReq(apps.a2, wardIds.w3, '平板床');
  svc.confirmRequest(r2.id, staffIds['N-302']);
  assert.throws(
    () => svc.allocateBed({ requestId: r2.id, bedId: beds3.flat1, staffId: staffIds['N-302'] }),
    (e) => e.code === 'BED_TAKEN'
  );
  // 第二张床仍可正常分配给另一申请
  const a2 = svc.allocateBed({ requestId: r2.id, bedId: beds3.flat2, staffId: staffIds['N-302'] });
  assert.equal(a2.bed.id, beds3.flat2);

  const active = svc.db.prepare("SELECT COUNT(*) c FROM rentals WHERE bed_id=? AND status='active'").get(beds3.flat1).c;
  assert.equal(active, 1);
});

// ---- 2) 两名护士（真实多线程）同时分配同一张床：恰好一人成功 ----
test('并发：两名护士同时分配同一床位，只允许一人成功', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'care-race-'));
  const dbPath = path.join(dir, 'race.db');
  const f = fixture(dbPath);
  // 两个独立申请，都指定同一张平板床 flat1
  const r1 = f.mkReq(f.apps.a1, f.wardIds.w3, '平板床');
  const r2 = f.mkReq(f.apps.a2, f.wardIds.w3, '平板床');
  f.svc.confirmRequest(r1.id, f.staffIds['N-301']);
  f.svc.confirmRequest(r2.id, f.staffIds['N-302']);
  f.db.close();

  const runWorker = (requestId, staffId) => new Promise((resolve) => {
    const w = new Worker(path.join(__dirname, 'alloc-worker.js'), {
      workerData: { dbPath, requestId, bedId: f.beds3.flat1, staffId },
    });
    w.on('message', resolve);
    w.on('error', (e) => resolve({ ok: false, code: 'WORKER_ERROR', message: String(e) }));
    w.postMessage('go');
  });

  const [res1, res2] = await Promise.all([
    runWorker(r1.id, f.staffIds['N-301']),
    runWorker(r2.id, f.staffIds['N-302']),
  ]);
  const winners = [res1, res2].filter((r) => r.ok);
  const losers = [res1, res2].filter((r) => !r.ok);

  assert.equal(winners.length, 1, `应有且仅有一人成功，实际成功 ${winners.length}：${JSON.stringify([res1, res2])}`);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].code, 'BED_TAKEN');

  // 用第三个连接核对：该床只有一条 active 时段，且只收了一笔押金
  const { open } = require('../src/db');
  const db = open(dbPath);
  const active = db.prepare("SELECT COUNT(*) c FROM rentals WHERE bed_id=? AND status='active'").get(f.beds3.flat1).c;
  assert.equal(active, 1);
  const deposits = db.prepare("SELECT COUNT(*) c FROM deposits WHERE kind='charge' AND rental_id IN (SELECT id FROM rentals WHERE bed_id=?)").get(f.beds3.flat1).c;
  assert.equal(deposits, 1);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- 3) 自动选床在竞争下也安全（唯一索引兜底）----
test('并发自动分配也不会在同床产生两个使用单', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'care-auto-'));
  const dbPath = path.join(dir, 'auto.db');
  const f = fixture(dbPath);
  // 病区里只有一张可用单摇床 single1（single2 先占用）
  f.svc.confirmRequest(f.mkReq(f.apps.a3, f.wardIds.w3, '单摇床').id, f.staffIds['N-301']);
  const occ = f.svc.createRequest({ applicantId: f.apps.a6, wardId: f.wardIds.w3, specRequired: '单摇床', plannedStart: f.t(-1), plannedEnd: f.t(23) });
  f.svc.confirmRequest(occ.id, f.staffIds['N-301']);
  f.svc.allocateBed({ requestId: occ.id, bedId: f.beds3.single2, staffId: f.staffIds['N-301'] });
  // 现在 single1 是唯一空闲单摇床。两个申请并发自动分配
  const r1 = f.svc.createRequest({ applicantId: f.apps.a4, wardId: f.wardIds.w3, specRequired: '单摇床', plannedStart: f.t(-1), plannedEnd: f.t(23) });
  const r2 = f.svc.createRequest({ applicantId: f.apps.a5, wardId: f.wardIds.w3, specRequired: '单摇床', plannedStart: f.t(-1), plannedEnd: f.t(23) });
  f.svc.confirmRequest(r1.id, f.staffIds['N-301']);
  f.svc.confirmRequest(r2.id, f.staffIds['N-302']);
  f.db.close();

  const runWorker = (requestId, staffId) => new Promise((resolve) => {
    const w = new Worker(path.join(__dirname, 'alloc-worker.js'), {
      workerData: { dbPath, requestId, bedId: null, staffId },
    });
    w.on('message', resolve);
    w.on('error', (e) => resolve({ ok: false, code: 'WORKER_ERROR', message: String(e) }));
    w.postMessage('go');
  });
  const [a, b] = await Promise.all([
    runWorker(r1.id, f.staffIds['N-301']),
    runWorker(r2.id, f.staffIds['N-302']),
  ]);
  const winners = [a, b].filter((r) => r.ok);
  assert.equal(winners.length, 1, `仅一张可用床时应恰好一人成功：${JSON.stringify([a, b])}`);
  fs.rmSync(dir, { recursive: true, force: true });
});
