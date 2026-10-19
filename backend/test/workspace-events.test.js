'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { subscribe, publishWorkspaceUpdate } = require('../src/events/workspaceEvents');

test('workspace updates reach only subscribers with workspace access', () => {
  const first = [];
  const second = [];
  const stopFirst = subscribe(['workspace-a'], (event) => first.push(event));
  const stopSecond = subscribe(['workspace-b'], (event) => second.push(event));

  publishWorkspaceUpdate('workspace-a');

  assert.equal(first.length, 1);
  assert.match(first[0], /event: workspace\.updated/);
  assert.match(first[0], /"workspaceId":"workspace-a"/);
  assert.deepEqual(second, []);

  stopFirst();
  stopSecond();
});

test('unsubscribed clients stop receiving updates', () => {
  const received = [];
  const stop = subscribe(['workspace-a'], (event) => received.push(event));

  stop();
  publishWorkspaceUpdate('workspace-a');

  assert.deepEqual(received, []);
});
