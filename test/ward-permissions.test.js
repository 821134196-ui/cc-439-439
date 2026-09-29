'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { fixture } = require('./helpers');

test('护士只能操作授权病区；跨病区确认/分配/消毒/维修/调拨被拒绝', () => {
  const { svc, beds3, beds5, staffIds, apps, wardIds, mkReq } = fixture();

  // 3W 的申请，5W 护士无权
  const req3 = mkReq(apps.a1, wardIds.w3, '平板床');
  assert.throws(() => svc.confirmRequest(req3.id, staffIds['N-501']), (e) => e.code === 'PERMISSION_DENIED');

  // 3W 护士确认后，5W 护士不能分配 3W 床位
  svc.confirmRequest(req3.id, staffIds['N-301']);
  assert.throws(
    () => svc.allocateBed({ requestId: req3.id, bedId: beds3.flat1, staffId: staffIds['N-501'] }),
    (e) => e.code === 'PERMISSION_DENIED'
  );

  // 5W 护士不能对 3W 床位开消毒/维修
  assert.throws(() => svc.createCleaningBatch(beds3.dirtyFlat, staffIds['N-501'], '紫外线'), (e) => e.code === 'PERMISSION_DENIED');
  assert.throws(() => svc.openRepair(beds3.double1, staffIds['N-501'], 'x'), (e) => e.code === 'PERMISSION_DENIED');

  // 总务（跨病区）可操作任意病区
  const b = svc.createCleaningBatch(beds3.dirtyFlat, staffIds['N-001'], '紫外线');
  assert.equal(b.id > 0, true);

  // 5W 护士在自己病区正常
  const req5 = mkReq(apps.a2, wardIds.w5, '平板床');
  svc.confirmRequest(req5.id, staffIds['N-501']);
  const a = svc.allocateBed({ requestId: req5.id, bedId: beds5.flat1, staffId: staffIds['N-501'] });
  assert.equal(a.bed.id, beds5.flat1);
});

test('调拨需双方责任人，且只能交出/接收各自病区；非责任人被拒', () => {
  const { svc, beds3, beds5, staffIds, wardIds, apps, mkReq } = fixture();
  // 3W → 5W，交出人 N-301，接收人 N-501
  const t = svc.proposeTransfer({
    fromWardId: wardIds.w3, toWardId: wardIds.w5, spec: '平板床',
    bedIds: [beds3.flat1, beds3.flat2], fromNurseId: staffIds['N-301'], toNurseId: staffIds['N-501'],
  });
  assert.equal(t.qty, 2);
  assert.equal(t.status, 'proposed');

  // 接收方不能替交出人交出
  assert.throws(() => svc.handOverTransfer(t.id, staffIds['N-501']), (e) => e.code === 'PERMISSION_DENIED');
  // 正确交出
  svc.handOverTransfer(t.id, staffIds['N-301']);
  // 交出后床位在途中不可被预约（3W 视角）
  const req = mkReq(apps.a3, wardIds.w3, '平板床');
  svc.confirmRequest(req.id, staffIds['N-302']);
  assert.throws(
    () => svc.allocateBed({ requestId: req.id, bedId: beds3.flat1, staffId: staffIds['N-302'] }),
    (e) => e.code === 'BED_IN_TRANSFER'
  );
  // 非接收责任人不能接收
  assert.throws(() => svc.receiveTransfer(t.id, staffIds['N-301']), (e) => e.code === 'PERMISSION_DENIED');
  // 正确接收
  const done = svc.receiveTransfer(t.id, staffIds['N-501']);
  assert.equal(done.status, 'received');
  // 床位归属已转到 5W，且调入后须重新消毒（is_clean=0）
  const now5 = svc.db.prepare('SELECT id,ward_id,is_clean FROM beds WHERE id IN (?,?)').all(beds3.flat1, beds3.flat2);
  for (const x of now5) { assert.equal(x.ward_id, wardIds.w5); assert.equal(x.is_clean, 0); }
});

test('不能向同病区调拨；占用中/维修中床位不能调拨；交接数量至少 1', () => {
  const { svc, beds3, staffIds, wardIds, mkReq, apps } = fixture();
  assert.throws(() => svc.proposeTransfer({
    fromWardId: wardIds.w3, toWardId: wardIds.w3, spec: '平板床',
    bedIds: [beds3.flat1], fromNurseId: staffIds['N-301'], toNurseId: staffIds['N-302'],
  }), (e) => e.code === 'BAD_INPUT');
  assert.throws(() => svc.proposeTransfer({
    fromWardId: wardIds.w3, toWardId: wardIds.w5, spec: '平板床',
    bedIds: [], fromNurseId: staffIds['N-301'], toNurseId: staffIds['N-501'],
  }), (e) => e.code === 'BAD_QTY');

  // 占用床不能调拨
  const req = mkReq(apps.a1, wardIds.w3, '平板床');
  svc.confirmRequest(req.id, staffIds['N-301']);
  svc.allocateBed({ requestId: req.id, bedId: beds3.flat1, staffId: staffIds['N-301'] });
  assert.throws(() => svc.proposeTransfer({
    fromWardId: wardIds.w3, toWardId: wardIds.w5, spec: '平板床',
    bedIds: [beds3.flat1], fromNurseId: staffIds['N-301'], toNurseId: staffIds['N-501'],
  }), (e) => e.code === 'BED_OCCUPIED');
});
