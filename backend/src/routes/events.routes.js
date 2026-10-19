'use strict';

const express = require('express');
const { query } = require('../db');
const { asyncHandler } = require('../lib/http');
const { subscribe, formatEvent } = require('../events/workspaceEvents');

const router = express.Router();
const HEARTBEAT_MS = 25_000;

router.get('/', asyncHandler(async (req, res) => {
  const workspaces = (await query(
    `SELECT wu.workspace_id
       FROM workspace_users wu
       JOIN workspaces w ON w.id = wu.workspace_id
      WHERE wu.user_id = $1 AND wu.status = 'active' AND w.status = 'active'`,
    [req.user.id],
  )).rows;

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const unsubscribe = subscribe(workspaces.map((row) => row.workspace_id), (event) => res.write(event));
  const heartbeat = setInterval(() => res.write(': keepalive\n\n'), HEARTBEAT_MS);
  heartbeat.unref();
  const expiresIn = Math.max(0, Number(req.user.accessTokenExpiresAt || 0) - Date.now());
  const expiry = setTimeout(() => res.end(), expiresIn);
  expiry.unref();
  res.write(formatEvent('connected', {}));

  req.on('close', () => {
    clearInterval(heartbeat);
    clearTimeout(expiry);
    unsubscribe();
  });
}));

module.exports = router;
