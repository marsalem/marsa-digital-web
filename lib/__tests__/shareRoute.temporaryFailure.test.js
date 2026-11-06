// lib/__tests__/shareRoute.temporaryFailure.test.js
// Run with: node --test lib/__tests__
//
// A dedicated file, not added onto shareRoute.creatorBlock.integration.
// test.js, because api/share/index.js destructures
// `const { createShare } = require('../../lib/shareService')` at its own
// module-load time — reassigning shareService.createShare AFTER that
// handler module has already been required has no effect on its already-
// bound local reference (confirmed directly: an earlier draft of this
// test lived in that sibling file and silently got a 201, not the
// intended 500, for exactly this reason). The mock here is set up BEFORE
// the handler's first require, same convention every other integration
// test file in this directory already follows.
//
// Purpose: prove that an unrelated, temporary failure (createShare
// throwing — e.g. a transient Redis hiccup) still gets the ORIGINAL
// generic 500 message, completely unaffected by the new, distinct
// blocked-creator message (api/share/index.js's own MESSAGE note).

process.env.UPSTASH_REDIS_REST_URL ||= 'https://example.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN ||= 'test-token';

const test = require('node:test');
const assert = require('node:assert/strict');

const shareService = require('../shareService');
const rateLimit = require('../rateLimit');
const creatorBlockLib = require('../creatorBlock');

shareService.createShare = async () => { throw new Error('simulated transient Redis failure'); };
rateLimit.checkCreateShareRateLimit = async () => ({ success: true });
creatorBlockLib.isCreatorBlocked = async () => false;
creatorBlockLib.recordShareCreator = async () => {};

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

test('an unrelated, temporary failure (createShare throwing) keeps its own existing generic message and status — unaffected by the blocked-creator message change', async () => {
  const req = makeReq(CLEAN_PAYLOAD, { 'x-creator-token': 'a-perfectly-fine-token' });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'Could not create share.' });
  assert.equal(res.body.blocked, undefined);
});
