'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { fixture, standardItems } = require('./helpers');

test('待消毒/未完成批次的床位不可预约，批次完成后恢复可用', () => {
  const { svc, beds3, staffIds, apps, wardIds, mkReq } = fixture();

  // dirtyFlat 初始 is_clean=0
  const req = mkReq(apps.a1, wardIds.w3, '平板床');
  svc.confirmRequest(req.id, staffIds['N-301']);
  assert.throws(
    () => svc.allocateBed({ requestId: req.id, bedId: beds3.dirtyFlat, staffId: staffIds['N-301'] }),
    (e) => e.code === 'BED_NOT_CLEAN'
  );

  // 开批次但未完成，仍不可约
  const b1 = svc.createCleaningBatch(beds3.dirtyFlat, staffIds['N-301'], '紫外线');
  assert.throws(
    () => svc.allocateBed({ requestId: req.id, bedId: beds3.dirtyFlat, staffId: staffIds['N-301'] }),
    (e) => e.code === 'BED_NOT_CLEAN'
  );
  svc.startBatch(b1.id, staffIds['N-301']);
  assert.throws(
    () => svc.allocateBed({ requestId: req.id, bedId: beds3.dirtyFlat, staffId: staffIds['N-301'] }),
    (e) => e.code === 'BED_NOT_CLEAN'
  );

  // 完成后可约
  svc.completeBatch(b1.id, staffIds['N-301']);
  const out = svc.allocateBed({ requestId: req.id, bedId: beds3.dirtyFlat, staffId: staffIds['N-301'] });
  assert.equal(out.bed.id, beds3.dirtyFlat);
});

test('归还后床位立即进入待消毒不可约；常规消毒完成后才重新可用', () => {
  const { svc, beds3, staffIds, apps, wardIds, mkReq } = fixture();
  const req = mkReq(apps.a1, wardIds.w3, '平板床');
  svc.confirmRequest(req.id, staffIds['N-301']);
  const a = svc.allocateBed({ requestId: req.id, bedId: beds3.flat1, staffId: staffIds['N-301'] });

  const ret = svc.recordReturn({
    rentalId: a.rental.id, staffId: staffIds['N-301'],
    frameResult: 'ok', mattressResult: 'ok',
    items: standardItems(svc, a.bed.id),
  });
  // 归还后床位脏、不可约
  let bed = svc.db.prepare('SELECT * FROM beds WHERE id=?').get(a.bed.id);
  assert.equal(bed.is_clean, 0);
  const req2 = mkReq(apps.a2, wardIds.w3, '平板床');
  svc.confirmRequest(req2.id, staffIds['N-302']);
  assert.throws(
    () => svc.allocateBed({ requestId: req2.id, bedId: a.bed.id, staffId: staffIds['N-302'] }),
    (e) => e.code === 'BED_NOT_CLEAN'
  );
  // 完成归还带出的批次 → 可约
  svc.startBatch(ret.cleaning.id, staffIds['N-302']);
  svc.completeBatch(ret.cleaning.id, staffIds['N-302']);
  const a2 = svc.allocateBed({ requestId: req2.id, bedId: a.bed.id, staffId: staffIds['N-302'] });
  assert.equal(a2.bed.id, a.bed.id);
});

test('污染归还触发隔离；消毒失败后床位仍不可约并自动补开批次', () => {
  const { svc, beds3, staffIds, apps, wardIds, mkReq } = fixture();
  const req = mkReq(apps.a1, wardIds.w3, '单摇床');
  svc.confirmRequest(req.id, staffIds['N-301']);
  const a = svc.allocateBed({ requestId: req.id, bedId: beds3.single1, staffId: staffIds['N-301'] });

  const ret = svc.recordReturn({
    rentalId: a.rental.id, staffId: staffIds['N-301'],
    frameResult: 'ok', mattressResult: 'contaminated',
    items: standardItems(svc, a.bed.id, { '床垫': { result: 'contaminated', actionReason: '体液污染，隔离消毒' } }),
    isolated: true,
  });
  const bed = svc.db.prepare('SELECT * FROM beds WHERE id=?').get(a.bed.id);
  assert.equal(bed.isolated, 1);
  assert.equal(bed.is_clean, 0);
  assert.equal(ret.cleaning.contamination, 1);
  assert.equal(ret.cleaning.method, '含氯擦拭');

  const req2 = mkReq(apps.a2, wardIds.w3, '单摇床');
  svc.confirmRequest(req2.id, staffIds['N-302']);
  assert.throws(
    () => svc.allocateBed({ requestId: req2.id, bedId: a.bed.id, staffId: staffIds['N-302'] }),
    (e) => ['BED_ISOLATED', 'BED_NOT_CLEAN'].includes(e.code)
  );

  // 消毒失败 → 自动补开，床位仍隔离
  svc.startBatch(ret.cleaning.id, staffIds['N-301']);
  const fail = svc.failBatch(ret.cleaning.id, staffIds['N-301'], '浓度不达标');
  assert.equal(fail.failed.status, 'failed');
  assert.equal(fail.retry.status, 'queued');
  const bedAfter = svc.db.prepare('SELECT * FROM beds WHERE id=?').get(a.bed.id);
  assert.equal(bedAfter.isolated, 1);
  assert.throws(
    () => svc.allocateBed({ requestId: req2.id, bedId: a.bed.id, staffId: staffIds['N-302'] }),
    (e) => ['BED_ISOLATED', 'BED_NOT_CLEAN'].includes(e.code)
  );

  // 重试批次完成（含解除隔离）→ 可约
  svc.startBatch(fail.retry.id, staffIds['N-302']);
  svc.completeBatch(fail.retry.id, staffIds['N-302']);
  const bedOk = svc.db.prepare('SELECT * FROM beds WHERE id=?').get(a.bed.id);
  assert.equal(bedOk.isolated, 0);
  assert.equal(bedOk.is_clean, 1);
  const a2 = svc.allocateBed({ requestId: req2.id, bedId: a.bed.id, staffId: staffIds['N-302'] });
  assert.equal(a2.bed.id, a.bed.id);
});

test('维修中的床位不得被预约；修复且清洁后才可约', () => {
  const { svc, beds3, staffIds, apps, wardIds, mkReq } = fixture();
  const rp = svc.openRepair(beds3.double1, staffIds['N-301'], '护栏松动');
  const bed = svc.db.prepare('SELECT * FROM beds WHERE id=?').get(beds3.double1);
  assert.equal(bed.is_maintenance, 1);

  const req = mkReq(apps.a1, wardIds.w3, '双摇床');
  svc.confirmRequest(req.id, staffIds['N-302']);
  assert.throws(
    () => svc.allocateBed({ requestId: req.id, bedId: beds3.double1, staffId: staffIds['N-302'] }),
    (e) => e.code === 'BED_IN_MAINTENANCE'
  );
  // 自动选床也不会选中维修床
  assert.throws(
    () => svc.allocateBed({ requestId: req.id, staffId: staffIds['N-302'] }),
    (e) => e.code === 'NO_AVAILABLE_BED'
  );
  // 关闭维修后仍需完成清洁（维修开单时置脏）
  svc.closeRepair(rp.id, staffIds['N-301']);
  assert.throws(
    () => svc.allocateBed({ requestId: req.id, bedId: beds3.double1, staffId: staffIds['N-302'] }),
    (e) => e.code === 'BED_NOT_CLEAN'
  );
  const b = svc.createCleaningBatch(beds3.double1, staffIds['N-302'], '紫外线');
  svc.startBatch(b.id, staffIds['N-302']);
  svc.completeBatch(b.id, staffIds['N-302']);
  const a = svc.allocateBed({ requestId: req.id, staffId: staffIds['N-302'] });
  assert.equal(a.bed.id, beds3.double1);
});

test('归还核验发现床架损坏自动开维修，阻断再次预约', () => {
  const { svc, beds3, staffIds, apps, wardIds, mkReq } = fixture();
  const req = mkReq(apps.a1, wardIds.w3, '平板床');
  svc.confirmRequest(req.id, staffIds['N-301']);
  const a = svc.allocateBed({ requestId: req.id, bedId: beds3.flat2, staffId: staffIds['N-301'] });
  const ret = svc.recordReturn({
    rentalId: a.rental.id, staffId: staffIds['N-301'],
    frameResult: 'damaged', mattressResult: 'ok',
    items: standardItems(svc, a.bed.id, { '床架': { result: 'damaged', actionReason: '支臂变形' } }),
  });
  assert.ok(ret.repair, '应自动生成维修单');
  const bed = svc.db.prepare('SELECT * FROM beds WHERE id=?').get(a.bed.id);
  assert.equal(bed.is_maintenance, 1);
  assert.equal(bed.is_clean, 0);
});
