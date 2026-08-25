'use strict';
// Structured logging. One JSON line per event, with a request id on every
// line written during a request so "what happened to this call" is one grep.
// Tokens, password hashes and raw provider payloads are never logged.
const crypto = require('crypto');
const pino = require('pino');
const config = require('../config');

const log = pino({
  level: config.env === 'test' ? 'silent' : (process.env.LOG_LEVEL || 'info'),
  base: { service: 'higherpays-api', env: config.env },
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'accessToken', 'refreshToken', 'password', 'password_hash', 'raw_payload', 'payload'],
    remove: true,
  },
});

/** Attaches `req.id` and `req.log`; logs one line per request on finish. */
function requestLogger(req, res, next) {
  const startedAt = process.hrtime.bigint();
  req.id = String(req.headers['x-request-id'] || crypto.randomUUID());
  res.setHeader('X-Request-Id', req.id);
  req.log = log.child({ reqId: req.id });

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    req.log.info({
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
      workspaceId: req.membership ? req.membership.workspaceId : undefined,
      userId: req.user ? req.user.id : undefined,
      ip: req.ip,
    }, 'request');
  });
  next();
}

module.exports = { log, requestLogger };
