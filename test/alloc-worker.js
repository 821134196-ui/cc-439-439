'use strict';
// 并发分配 worker：两个 worker 同时 BEGIN IMMEDIATE 抢同一张床
const { parentPort, workerData } = require('node:worker_threads');
const { open } = require('../src/db');
const { createServices } = require('../src/services');

parentPort.on('message', (msg) => {
  if (msg !== 'go') return;
  let result;
  const db = open(workerData.dbPath);
  const svc = createServices(db);
  try {
    const out = svc.allocateBed({ requestId: workerData.requestId, bedId: workerData.bedId, staffId: workerData.staffId });
    result = { ok: true, rentalId: out.rental.id, bedId: out.bed.id };
  } catch (e) {
    result = { ok: false, code: e.code, message: e.message };
  } finally {
    db.close();
  }
  parentPort.postMessage(result);
  // 主动结束 worker，避免消息端口使测试运行器常驻
  setImmediate(() => process.exit(0));
});
