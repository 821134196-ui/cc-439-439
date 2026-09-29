'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { fixture, standardItems } = require('./helpers');

test('临时换床：原床进入清洁，新床占用；完成清洁后原床可再用', () => {
  const { svc, beds3, staffIds, apps, wardIds, mkReq } = fixture();
  const req = mkReq(apps.a1, wardIds.w3, '平板床');
  svc.confirmRequest(req.id, staffIds['N-301']);
  const a = svc.allocateBed({ requestId: req.id, bedId: beds3.flat1, staffId: staffIds['N-301'] });

  const out = svc.swapBed({ rentalId: a.rental.id, toBedId: beds3.flat2, staffId: staffIds['N-302'], reason: '空调滴水' });
  assert.equal(out.rental.bed_id, beds3.flat2);
  // 新床被占用
  assert.ok(svc.db.prepare("SELECT 1 FROM rentals WHERE bed_id=? AND status='active'").get(beds3.flat2));
  // 原床变脏、解除占用，并产生清洁批次
  const old = svc.db.prepare('SELECT * FROM beds WHERE id=?').get(beds3.flat1);
  assert.equal(old.is_clean, 0);
  assert.equal(old.current_rental_id, null);
  assert.equal(out.cleaning.status, 'queued');
  // 换到不同规格 / 自己 / 跨病区被拒
  assert.throws(() => svc.swapBed({ rentalId: a.rental.id, toBedId: beds3.single1, staffId: staffIds['N-302'], reason: 'x' }),
    (e) => e.code === 'SPEC_MISMATCH');
});

test('超时归还：超过宽限期产生超时费并写入事件', () => {
  const { svc, beds3, staffIds, apps, wardIds } = fixture();
  // 规划 5 小时前结束 → 远超 30 分钟宽限
  const req = svc.createRequest({
    applicantId: apps.a1, wardId: wardIds.w3, specRequired: '平板床',
    plannedStart: new Date(Date.now() - 10 * 3600e3).toISOString(),
    plannedEnd: new Date(Date.now() - 5 * 3600e3).toISOString(),
  });
  svc.confirmRequest(req.id, staffIds['N-301']);
  const bed = svc.allocateBed({ requestId: req.id, bedId: beds3.flat1, staffId: staffIds['N-301'] });
  const ret = svc.recordReturn({
    rentalId: bed.rental.id, staffId: staffIds['N-301'],
    frameResult: 'ok', mattressResult: 'ok', items: standardItems(svc, bed.bed.id),
  });
  assert.equal(ret.overtime.overtime, true);
  // 5h=300min − 30 宽限 = 270min → ceil(270/60)=5 小时 × 200 = 1000 分
  assert.equal(ret.overtime.feeFen, 1000);
  svc.startBatch(ret.cleaning.id, staffIds['N-301']);
  svc.completeBatch(ret.cleaning.id, staffIds['N-301']);
  const s = svc.settleRental(bed.rental.id, staffIds['N-301'], 'ot');
  assert.equal(s.deduct_fen, 1000);
  assert.equal(s.refund_fen, 29000);
  const ev = svc.timeline({ rentalId: bed.rental.id }).find((e) => e.type === 'overtime');
  assert.ok(ev);
});

test('完整生命周期：申请→确认→分配(收押金)→换床→归还(缺失)→消毒→结算', () => {
  const f = fixture();
  const { svc, beds3, staffIds, apps, wardIds } = f;
  const req = f.mkReq(apps.a1, wardIds.w3, '平板床');
  assert.equal(req.status, 'queued');
  svc.confirmRequest(req.id, staffIds['N-301']);
  const a = svc.allocateBed({ requestId: req.id, staffId: staffIds['N-301'] });
  assert.equal(a.bed.is_clean, 1);
  assert.equal(a.deposit.kind, 'charge');
  assert.equal(a.deposit.amount_fen, 30000);

  svc.swapBed({ rentalId: a.rental.id, toBedId: beds3.flat2, staffId: staffIds['N-302'], reason: '靠门通风' });
  const items = standardItems(svc, a.rental.bed_id /* 注意：换床后配件仍按床台账，演示用新床 */, {
    '枕套': { actualQty: 0, result: 'missing', actionReason: '枕套遗失' },
  });
  const ret = svc.recordReturn({
    rentalId: a.rental.id, staffId: staffIds['N-302'],
    frameResult: 'ok', mattressResult: 'ok', items,
  });
  assert.equal(ret.check.summary_result, 'fail');
  svc.startBatch(ret.cleaning.id, staffIds['N-302']);
  svc.completeBatch(ret.cleaning.id, staffIds['N-302']);
  const s = svc.settleRental(a.rental.id, staffIds['N-302'], 'e2e');
  assert.equal(s.deduct_fen, 2000); // 枕套 2000
  assert.equal(s.refund_fen, 28000);
  const rental = svc.getRental(a.rental.id);
  assert.equal(rental.status, 'returned');
  assert.equal(rental.finalized, 1);
  assert.equal(svc.getRequest(req.id).status, 'completed');
});
