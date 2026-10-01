'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveAccounts, resolveAgents } = require('../scripts/reconcile-legacy-recovery');

test('uses only customer-confirmed creator aliases', () => {
  const result = resolveAccounts([
    { id: 'source-dina', name: 'Dina', email: 'dina@example.com' },
    { id: 'source-tamar', name: 'Tamar', email: 'tamar@example.com' },
    { id: 'source-bar', name: 'Bar', email: 'bar@example.com' },
  ], [
    { id: 'target-bohema', name: 'Bohema', email: 'other@example.com' },
    { id: 'target-emuna', name: 'Emuna', email: 'another@example.com' },
    { id: 'target-bar', name: 'Bar', email: 'bar@example.com' },
  ]);

  assert.equal(result.mappings.get('source-dina').targetId, 'target-bohema');
  assert.equal(result.mappings.get('source-tamar').targetId, 'target-emuna');
  assert.equal(result.mappings.has('source-bar'), false);
  assert.deepEqual(result.blocked, [{
    sourceId: 'source-bar',
    sourceName: 'Bar',
    reason: 'ambiguous_customer_mapping',
  }]);
});

test('maps agents only by a unique email', () => {
  const result = resolveAgents([
    { id: 'source-agent', full_name: 'Agent', email: 'agent@example.com' },
    { id: 'source-unknown', full_name: 'Unknown', email: 'unknown@example.com' },
  ], [
    { id: 'target-agent', full_name: 'Different display name', email: 'AGENT@example.com' },
  ]);

  assert.equal(result.mappings.get('source-agent').targetId, 'target-agent');
  assert.deepEqual(result.blocked, [{
    sourceId: 'source-unknown',
    sourceName: 'Unknown',
    reason: 'no_unique_target_agent_email',
  }]);
});
