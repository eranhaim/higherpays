'use strict';

const crypto = require('crypto');

const subscribers = new Map();

function formatEvent(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function subscribe(workspaceIds, send) {
  const id = crypto.randomUUID();
  subscribers.set(id, { workspaceIds: new Set(workspaceIds), send });
  return () => subscribers.delete(id);
}

function publishWorkspaceUpdate(workspaceId) {
  const event = formatEvent('workspace.updated', { workspaceId });
  for (const [id, subscriber] of subscribers) {
    if (!subscriber.workspaceIds.has(workspaceId)) continue;
    try {
      subscriber.send(event);
    } catch {
      subscribers.delete(id);
    }
  }
}

module.exports = { formatEvent, subscribe, publishWorkspaceUpdate };
