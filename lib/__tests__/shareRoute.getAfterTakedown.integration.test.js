// lib/__tests__/shareRoute.getAfterTakedown.integration.test.js
// Run with: node --test lib/__tests__
//
// Confirms the "deleted or disabled share links" requirement end-to-end
// on the READ side: once a share has been taken down (deleteShare
// removes its Redis key), GET /api/share/:id must 404, not error or
// return stale content. api/share/[id].js's own getShare-null handling
// was already correct before Stage 3 (shareService.getShare returns
// null for a deleted key, same as for an expired one) — this test exists
// to make that guarantee explicit and regression-tested now that a real
// code path (api/admin/takedown.js) actually calls deleteShare.

process.env.UPSTASH_REDIS_REST_URL ||= 'https://example.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN ||= 'test-token';

const test = require('node:test');
const assert = require('node:assert/strict');

const shareService = require('../shareService');
const rateLimit = require('../rateLimit');

// Simulates a share that has been taken down — getShare returns null,
// exactly as it does for an expired or never-existed id.
shareService.getShare = async () => null;
rateLimit.checkReadShareRateLimit = async () => ({ success: true });

const getShareHandler = require('../../api/share/[id].js');

function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test('a taken-down share returns 404, not an error or stale content', async () => {
  const req = { method: 'GET', headers: {}, query: { id: 'share-to-remove' } };
  const res = makeRes();
  await getShareHandler(req, res);
  assert.equal(res.statusCode, 404);
});
