'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { fixture, standardItems } = require('./helpers');

test('同一幂等键重复提交押金：只入账一次，返回 duplicated', () => {
  const { svc, db, staffIds, apps, wardIds, mkReq } = fixture();
  const req = mkReq(apps.a1, wardIds.w3, '平板床');
  svc.confirmRequest(req.id, staffIds['N-301']);
  const args = {
    idemKey: 'manual:req:' + req.id + ':bonus',
    requestId: req.id, kind: 'topup', amountFen: 5000, reason: '测试补缴',
  };
  const d1 = svc.postDeposit(args, staffIds['N-301']);
  const d2 = svc.postDeposit({ ...args }, staffIds['N-301']);
  const d3 = svc.postDeposit({ ...args }, staffIds['N-301']);
  assert.equal(d1.duplicated, false);
  assert.equal(d2.duplicated, true);
  assert.equal(d3.duplicated, true);
  assert.equal(d2.code, d1.code);
  const cnt = db.prepare('SELECT COUNT(*) c FROM deposits WHERE idem_key=?').get(args.idemKey).c;
  assert.equal(cnt, 1);
  const sum = db.prepare('SELECT COALESCE(SUM(amount_fen),0) s FROM deposits WHERE idem_key=?').get(args.idemKey).s;
  assert.equal(sum, 5000);
});

test('分配收取押金使用稳定幂等键，重复链路不会重复收取', () => {
  const { svc, db, beds3, staffIds, apps, wardIds, mkReq } = fixture();
  const req = mkReq(apps.a1, wardIds.w3, '平板床');
  svc.confirmRequest(req.id, staffIds['N-301']);
  svc.allocateBed({ requestId: req.id, bedId: beds3.flat1, staffId: staffIds['N-301'] });
  // 直接以分配所用幂等键再收一次 → 命中既有流水
  const dup = svc.postDeposit({
    idemKey: `charge:req:${req.id}`, requestId: req.id, kind: 'charge', amountFen: 30000, reason: '押金',
  }, staffIds['N-301']);
  assert.equal(dup.duplicated, true);
  const cnt = db.prepare("SELECT COUNT(*) c FROM deposits WHERE request_id=? AND kind='charge'").get(req.id).c;
  assert.equal(cnt, 1);
});

test('模拟网关失败时整笔押金回滚，不留半截流水；重试成功', () => {
  const { svc, db, staffIds, apps, wardIds, mkReq } = fixture();
  const req = mkReq(apps.a1, wardIds.w3, '平板床');
  svc.confirmRequest(req.id, staffIds['N-301']);
  svc.adapter.failOnce = 1;
  assert.throws(
    () => svc.postDeposit({ idemKey: 'k-fail', requestId: req.id, kind: 'topup', amountFen: 1000, reason: 'x' }, staffIds['N-301']),
    (e) => e.code === 'GATEWAY_ERROR'
  );
  assert.equal(db.prepare('SELECT COUNT(*) c FROM deposits WHERE idem_key=?').get('k-fail').c, 0);
  // 网关恢复后用同一键重试成功
  const d = svc.postDeposit({ idemKey: 'k-fail', requestId: req.id, kind: 'topup', amountFen: 1000, reason: 'x' }, staffIds['N-301']);
  assert.equal(d.duplicated, false);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM deposits WHERE idem_key=?').get('k-fail').c, 1);
});

test('结算只允许一次；结算后迟到归还不能重开订单', () => {
  const { svc, beds3, staffIds, apps, wardIds, mkReq } = fixture();
  const req = mkReq(apps.a1, wardIds.w3, '平板床');
  svc.confirmRequest(req.id, staffIds['N-301']);
  const bed = svc.allocateBed({ requestId: req.id, bedId: beds3.flat1, staffId: staffIds['N-301'] });
  const ret = svc.recordReturn({
    rentalId: bed.rental.id, staffId: staffIds['N-301'],
    frameResult: 'ok', mattressResult: 'ok', items: standardItems(svc, bed.bed.id),
  });
  svc.startBatch(ret.cleaning.id, staffIds['N-301']);
  svc.completeBatch(ret.cleaning.id, staffIds['N-301']);

  const s1 = svc.settleRental(bed.rental.id, staffIds['N-301'], 'key-A');
  assert.equal(s1.deduct_fen, 0);
  assert.equal(s1.refund_fen, 30000);
  // 换幂等键再次结算也必须被拒（订单已关闭）
  assert.throws(
    () => svc.settleRental(bed.rental.id, staffIds['N-301'], 'key-B'),
    (e) => e.code === 'ALREADY_FINALIZED'
  );
  const rental = svc.getRental(bed.rental.id);
  assert.equal(rental.finalized, 1);
  // 押金流水不重复：仅一笔收取、一笔退还
  const refunds = svc.db.prepare("SELECT COUNT(*) c FROM deposits WHERE rental_id=? AND kind='refund'").get(bed.rental.id).c;
  assert.equal(refunds, 1);
});

test('押金不足时生成差异补缴，且补缴金额正确、幂等', () => {
  const { svc, beds3, staffIds, apps, wardIds, mkReq } = fixture();
  const req = mkReq(apps.a1, wardIds.w3, '平板床');
  svc.confirmRequest(req.id, staffIds['N-301']);
  const bed = svc.allocateBed({ requestId: req.id, bedId: beds3.flat1, staffId: staffIds['N-301'] });
  // 呼叫器缺失 15000 + 薄被缺失 8000 + 被套缺失 6000 = 29000（<30000，走扣除）
  // 再加 床垫损坏 6000 = 35000（>30000，走补缴 5000）
  const items = standardItems(svc, bed.bed.id, {
    '呼叫器': { actualQty: 0, result: 'missing', actionReason: '遗失' },
    '薄被': { actualQty: 0, result: 'missing', actionReason: '遗失' },
    '被套': { actualQty: 0, result: 'missing', actionReason: '遗失' },
    '床垫': { result: 'damaged', actionReason: '划破' },
  });
  const ret = svc.recordReturn({
    rentalId: bed.rental.id, staffId: staffIds['N-301'],
    frameResult: 'ok', mattressResult: 'damaged', items,
  });
  svc.startBatch(ret.cleaning.id, staffIds['N-301']);
  svc.completeBatch(ret.cleaning.id, staffIds['N-301']);
  const s = svc.settleRental(bed.rental.id, staffIds['N-301'], 'topup-case');
  assert.equal(s.deduct_fen, 15000 + 8000 + 6000 + 6000);
  assert.equal(s.deposited_fen, 30000);
  assert.equal(s.refund_fen, 0);
  const topup = s.deposits.find((d) => d.kind === 'topup');
  assert.ok(topup, '应产生差异补缴流水');
  assert.equal(topup.amount_fen, s.deduct_fen - 30000);
});
