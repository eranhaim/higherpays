'use strict';
// Worker-thread entry for parseInWorker: receives the workbook bytes, replies
// with the parsed result or a serialisable error.
const { parentPort, workerData } = require('worker_threads');
const { parseSettlementWorkbook } = require('./parse');

parseSettlementWorkbook(Buffer.from(workerData))
  .then((result) => parentPort.postMessage({ ok: true, result }))
  .catch((e) => parentPort.postMessage({ ok: false, error: e.message, status: e.status, detail: e.detail }));
