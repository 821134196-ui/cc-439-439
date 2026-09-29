'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { fixture, standardItems } = require('./helpers');

function returnAndSettle(svc, staffId, bed, items, extra = {}) {
  const ret = svc.recordReturn({
    rentalId: bed.rental.id, staffId,
    frameResult: extra.frameResult || 'ok',
    mattressResult: extra.mattressResult || 'ok',
    items, isolated: !!extra.isolated, note: extra.note || '',
  });
  svc.startBatch(ret.cleaning.id, staffId);
  svc.completeBatch(ret.cleaning.id, staffId);
  const settlement = svc.settleRental(bed.rental.id, staffId, 't-' + bed.rental.id);
  return { ret, settlement };
}

test('配件按台账数量核对：呼叫器缺 1、脚轮缺 2，按数量计赔并从押金扣除', () => {
  const { svc, beds3, staffIds, apps, wardIds, mkReq } = fixture();
  const req = mkReq(apps.a1, wardIds.w3, '平板床');
  svc.confirmRequest(req.id, staffIds['N-301']);
  const bed = svc.allocateBed({ requestId: req.id, bedId: beds3.flat1, staffId: staffIds['N-301'] });

  const items = standardItems(svc, bed.bed.id, {
    '呼叫器': { actualQty: 0, result: 'missing', actionReason: '呼叫器遗失，按价赔偿' },
    '脚轮': { actualQty: 2, result: 'missing', actionReason: '归还时仅 2 只脚轮，缺 2 只' },
  });
  const { ret, settlement } = returnAndSettle(svc, staffIds['N-301'], bed, items);

  // 核验明细按应有/实际数量落库
  const rows = ret.items;
  const caller = rows.find((r) => r.item === '呼叫器');
  assert.equal(caller.expected_qty, 1);
  assert.equal(caller.actual_qty, 0);
  assert.equal(caller.result, 'missing');
  const wheel = rows.find((r) => r.item === '脚轮');
  assert.equal(wheel.expected_qty, 4);
  assert.equal(wheel.actual_qty, 2);

  // 赔偿：呼叫器 15000 + 脚轮缺 2 × 6000 = 27000；押金 30000，退 3000
  assert.equal(settlement.deduct_fen, 15000 + 2 * 6000);
  assert.equal(settlement.refund_fen, 30000 - settlement.deduct_fen);
  assert.ok(settlement.charges.some((c) => c.label.includes('呼叫器')));
  assert.ok(settlement.charges.some((c) => c.label.includes('脚轮×2')));
});

test('床品缺失计入赔偿；全部完好则全额退还', () => {
  const { svc, beds3, staffIds, apps, wardIds, mkReq } = fixture();
  const req = mkReq(apps.a2, wardIds.w3, '单摇床');
  svc.confirmRequest(req.id, staffIds['N-302']);
  const bed = svc.allocateBed({ requestId: req.id, bedId: beds3.single2, staffId: staffIds['N-302'] });

  const items = standardItems(svc, bed.bed.id, {
    '床单': { actualQty: 0, result: 'missing', actionReason: '床单遗失' },
  });
  const { settlement } = returnAndSettle(svc, staffIds['N-302'], bed, items);
  assert.equal(settlement.deduct_fen, 4000);
  assert.equal(settlement.refund_fen, 26000);

  // 另一单全部完好 → 全额退
  const req2 = mkReq(apps.a3, wardIds.w3, '双摇床');
  svc.confirmRequest(req2.id, staffIds['N-302']);
  const bed2 = svc.allocateBed({ requestId: req2.id, bedId: beds3.double1, staffId: staffIds['N-302'] });
  const ok = returnAndSettle(svc, staffIds['N-302'], bed2, standardItems(svc, bed2.bed.id));
  assert.equal(ok.settlement.deduct_fen, 0);
  assert.equal(ok.settlement.refund_fen, 30000);
});

test('异常项缺少处理原因被拒绝；负数数量被拒绝', () => {
  const { svc, beds3, staffIds, apps, wardIds, mkReq } = fixture();
  const req = mkReq(apps.a1, wardIds.w3, '平板床');
  svc.confirmRequest(req.id, staffIds['N-301']);
  const bed = svc.allocateBed({ requestId: req.id, bedId: beds3.flat2, staffId: staffIds['N-301'] });

  const badReason = standardItems(svc, bed.bed.id, {
    '呼叫器': { actualQty: 0, result: 'missing', actionReason: '' },
  });
  assert.throws(
    () => svc.recordReturn({ rentalId: bed.rental.id, staffId: staffIds['N-301'], frameResult: 'ok', mattressResult: 'ok', items: badReason }),
    (e) => e.code === 'REASON_REQUIRED'
  );

  const badQty = standardItems(svc, bed.bed.id, {
    '脚轮': { actualQty: -1, result: 'missing', actionReason: 'x' },
  });
  assert.throws(
    () => svc.recordReturn({ rentalId: bed.rental.id, staffId: staffIds['N-301'], frameResult: 'ok', mattressResult: 'ok', items: badQty }),
    (e) => e.code === 'BAD_QTY'
  );
  // 核验失败不应改动使用单状态
  const rental = svc.getRental(bed.rental.id);
  assert.equal(rental.status, 'active');
});

test('损坏配件按应有数量计赔', () => {
  const { svc, beds3, staffIds, apps, wardIds, mkReq } = fixture();
  const req = mkReq(apps.a1, wardIds.w3, '平板床');
  svc.confirmRequest(req.id, staffIds['N-301']);
  const bed = svc.allocateBed({ requestId: req.id, bedId: beds3.flat1, staffId: staffIds['N-301'] });
  const items = standardItems(svc, bed.bed.id, {
    '护栏': { actualQty: 2, result: 'damaged', actionReason: '两片护栏变形' },
  });
  const { settlement } = returnAndSettle(svc, staffIds['N-301'], bed, items);
  // 护栏单价 12000 × 2 = 24000
  assert.equal(settlement.deduct_fen, 24000);
  assert.equal(settlement.refund_fen, 6000);
});
