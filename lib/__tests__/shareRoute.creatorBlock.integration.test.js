// lib/__tests__/shareRoute.creatorBlock.integration.test.js
// Run with: node --test lib/__tests__
//
// Integration tests for the creator-blocking check wired into
// api/share/index.js. Same monkey-patch-before-first-require technique
// as the other integration test files in this directory.

process.env.UPSTASH_REDIS_REST_URL ||= 'https://example.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN ||= 'test-token';

const test = require('node:test');
const assert = require('node:assert/strict');

const shareService = require('../shareService');
const rateLimit = require('../rateLimit');
const creatorBlockLib = require('../creatorBlock');

let createShareCalled = false;
let recordShareCreatorCalls = [];
let blockedTokens = new Set(['blocked-token-123']);

shareService.createShare = async () => {
  createShareCalled = true;
  return { shareId: 'fake-id' };
};
rateLimit.checkCreateShareRateLimit = async () => ({ success: true });
creatorBlockLib.isCreatorBlocked = async (token) => blockedTokens.has(token);
creatorBlockLib.recordShareCreator = async (shareId, token, ttlSeconds) => {
  recordShareCreatorCalls.push({ shareId, token, ttlSeconds });
};

const handler = require('../../api/share/index.js');

function makeReq(body, headers = {}) {
  return { method: 'POST', headers, query: {}, body };
}
function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

const CLEAN_PAYLOAD = {
  type: 'qatlas_playlist', version: 1,
  playlist: { id: 'p', name: 'Morning Recitation', items: [], createdAt: 1 },
};

test.beforeEach(() => {
  createShareCalled = false;
  recordShareCreatorCalls = [];
});

test('a request from a blocked creator token is rejected before createShare ever runs', async () => {
  const req = makeReq(CLEAN_PAYLOAD, { 'x-creator-token': 'blocked-token-123' });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(createShareCalled, false);
  // Generic message, identical to the content-filter rejection — must
  // not reveal that this was specifically a block, not a content issue.
  assert.deepEqual(res.body, { error: "This content can't be shared." });
});

test('a request with no creator token at all (older app version) is never blocked', async () => {
  const req = makeReq(CLEAN_PAYLOAD, {});
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 201);
  assert.equal(createShareCalled, true);
  // No token to record either — recordShareCreator's own no-op contract.
  assert.equal(recordShareCreatorCalls.length, 1);
  assert.equal(recordShareCreatorCalls[0].token, undefined);
});

test('a request from a non-blocked token succeeds and records the creator', async () => {
  const req = makeReq(CLEAN_PAYLOAD, { 'x-creator-token': 'a-perfectly-fine-token' });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 201);
  assert.equal(createShareCalled, true);
  assert.equal(recordShareCreatorCalls.length, 1);
  assert.equal(recordShareCreatorCalls[0].token, 'a-perfectly-fine-token');
  assert.equal(recordShareCreatorCalls[0].shareId, 'fake-id');
});
