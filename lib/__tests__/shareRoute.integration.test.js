// lib/__tests__/shareRoute.integration.test.js
// Run with: node --test lib/__tests__
//
// Integration test for api/share/index.js's actual handler wiring —
// proves the real execution order (rate limit -> size -> shape ->
// content filter -> createShare) rather than just each piece in
// isolation. Monkey-patches shareService.createShare and
// rateLimit.checkCreateShareRateLimit on the shared module objects BEFORE
// first requiring the handler — CommonJS's module cache means the
// handler's own `const { createShare } = require(...)` destructuring
// captures whatever is on those objects at that moment, so no real Redis
// connection or experimental module-mocking flag is needed.

process.env.UPSTASH_REDIS_REST_URL ||= 'https://example.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN ||= 'test-token';

const test = require('node:test');
const assert = require('node:assert/strict');

const shareService = require('../shareService');
const rateLimit = require('../rateLimit');

let createShareCalled = false;
shareService.createShare = async () => {
  createShareCalled = true;
  return { shareId: 'fake-id' };
};
rateLimit.checkCreateShareRateLimit = async () => ({ success: true });

const handler = require('../../api/share/index.js');

function makeReq(body) {
  return { method: 'POST', headers: {}, query: {}, body };
}

function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test.beforeEach(() => { createShareCalled = false; });

test('a content-filter-rejected payload never reaches createShare', async () => {
  const req = makeReq({
    type: 'qatlas_card', version: 1,
    card: { id: 'c', title: 'you dirty faggot', titleAr: 'ت', scenario: 's', scenarioAr: 'س', verseRefs: [], color: '#000' },
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(createShareCalled, false);
  // Generic response — must not reveal the matched category/term.
  assert.equal(JSON.stringify(res.body).toLowerCase().includes('slur'), false);
  assert.equal(JSON.stringify(res.body).toLowerCase().includes('faggot'), false);
});

test('a shape-invalid payload is rejected before the content filter or createShare ever run', async () => {
  const req = makeReq({ type: 'not_a_real_type' });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(createShareCalled, false);
});

test('a clean, valid payload reaches createShare and succeeds', async () => {
  const req = makeReq({
    type: 'qatlas_card', version: 1,
    card: { id: 'c', title: 'On patience', titleAr: 'عن الصبر', scenario: 's', scenarioAr: 'س', verseRefs: [], color: '#000' },
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 201);
  assert.equal(createShareCalled, true);
  assert.deepEqual(res.body, { shareId: 'fake-id' });
});

test('a payload with curated Ayah text containing a flagged root word still reaches createShare', async () => {
  const req = makeReq({
    type: 'qatlas_topic', version: 1,
    node: {
      id: 'n1', name: 'Patience', verses: [], children: [],
      note: JSON.stringify([
        { id: 'b1', type: 'ayah', surah: 2, ayah: 191, arabic: 'فاقتلوهم حيث وجدتموهم', english: 'and kill them wherever you overtake them', surahName: 'Al-Baqarah', surahNameAr: 'البقرة' },
      ]),
    },
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 201);
  assert.equal(createShareCalled, true);
});
