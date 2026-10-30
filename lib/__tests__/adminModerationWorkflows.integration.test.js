// lib/__tests__/adminModerationWorkflows.integration.test.js
// Run with: node --test lib/__tests__
//
// Full end-to-end admin moderation workflow tests. Unlike every other
// integration test in this directory (adminUiRoutes.integration.test.js,
// reportAndAdmin.integration.test.js, shareRoute.*.integration.test.js —
// all of which mock the SERVICE-LAYER FUNCTIONS directly), this file
// mocks ONLY the Redis client boundary. Every one of the following is
// the REAL, unmocked implementation, wired together exactly as
// Production wires them:
//   - api/admin-ui/login.js, dismiss-report.js, takedown.js, block-creator.js
//   - lib/adminSession.js
//   - lib/reportService.js
//   - lib/shareService.js
//   - lib/creatorBlock.js
//
// This is what proves "Block Creator and Take down actually work," not
// just "the route calls the right function name" — a real login produces
// a real cookie that the real session guard accepts, which then lets a
// real moderation action run real Redis list/set/key operations against
// one shared fake Redis, with results verified by calling the real
// service functions again afterward (getShare, listOpenReports,
// isCreatorBlocked) — not by inspecting mock call logs.
//
// THE ONE EXCEPTION — lib/rateLimit.js: @upstash/ratelimit's sliding-
// window algorithm needs Lua-script/sorted-set support this file's
// minimal FakeRedis does not implement, and rate-limit correctness is
// already covered elsewhere (rateLimit.test.js's clientIp() tests,
// adminUiRoutes.integration.test.js's dedicated rate-limit-rejection
// tests). Reimplementing a Lua-script-capable fake purely to satisfy an
// unrelated dependency would add real complexity for zero coverage gain
// here, so checkAdminRateLimit/checkAdminUiLoginRateLimit are mocked to
// always succeed — the one "unavoidable external runtime boundary"
// exception, not a shortcut on anything this file is actually testing.
//
// ── FakeRedis — one shared instance for the whole file ──
// Implements exactly the commands the real modules above issue, across
// three internal stores (a given key name is only ever used as one of
// these, matching the real key-prefix conventions each module documents
// in its own header):
//   store  (string keys)  — admin-session:<id>, report:<id>,
//                            share:<id>, share-creator:<shareId>,
//                            blocked:creator:<token>
//   lists  (list keys)    — reports:open, reports:resolved
//   sets   (set keys)     — creator-shares:<token>
//
// Commands implemented, and why each one's semantics matter here:
//   get/set     — plain key read/write. TTL (the `{ex}` option) is
//                 ACCEPTED but not enforced — this fake has no clock, so
//                 "a key expired" is simulated the same way every sibling
//                 fake in this directory does it: deleting it directly,
//                 observably identical to a lapsed TTL. This means a test
//                 for "expired share/report/session" must delete the key
//                 itself rather than waiting — no such test is attempted
//                 in this file (Stage A's reportService.test.js already
//                 covers that case for reports).
//   del         — returns the real count of keys actually removed across
//                 ALL three stores, matching shareService.deleteShare's
//                 own `deletedCount > 0` boolean contract and
//                 creatorBlock.js's post-block set purge.
//   rpush       — appends to a list; matches reportService's open/
//                 resolved list bookkeeping.
//   lrange      — real negative-index semantics (0,-1 = whole list),
//                 needed for listOpenReports' full LRANGE read.
//   lrem(0,...) — real "remove every occurrence" semantics (count=0) —
//                 this is specifically what resolveReport's removal from
//                 reports:open depends on.
//   ltrim       — real negative-index trim semantics, needed for
//                 resolveReport's cap on reports:resolved (not re-tested
//                 for the exact 500 boundary here — Stage A already did
//                 that in isolation; this file only needs it to not
//                 corrupt the list).
//   sadd/smembers — real Set-backed membership, needed for
//                 creatorBlock's creator-shares:<token> index and its
//                 block-time enumeration.
//   expire      — recorded for completeness (creatorBlock calls it after
//                 every sadd); not enforced, same no-clock limitation as
//                 the TTL option on set().
//
// LIMITATIONS, stated plainly: no real TTL/expiry countdown anywhere
// (no fake clock — same limitation every sibling FakeRedis in this
// directory already has), and no Lua/scripting support (irrelevant here
// since rate limiting is mocked, not real, for the reason above).

process.env.UPSTASH_REDIS_REST_URL ||= 'https://example.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN ||= 'test-token';
process.env.ADMIN_UI_PASSWORD = 'integration-test-password';

const test = require('node:test');
const assert = require('node:assert/strict');

class FakeRedis {
  constructor() {
    this.store = new Map();
    this.lists = new Map();
    this.sets = new Map();
  }
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async set(key, value /* , opts — {ex} accepted, not enforced; see header */) {
    this.store.set(key, String(value));
    return 'OK';
  }
  async del(...keys) {
    let count = 0;
    for (const key of keys) {
      if (this.store.delete(key)) count++;
      if (this.lists.delete(key)) count++;
      if (this.sets.delete(key)) count++;
    }
    return count;
  }
  async rpush(key, ...values) {
    const list = this.lists.get(key) || [];
    for (const v of values) list.push(String(v));
    this.lists.set(key, list);
    return list.length;
  }
  async lrange(key, start, stop) {
    const list = this.lists.get(key) || [];
    const len = list.length;
    if (len === 0) return [];
    const s = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
    const e = stop < 0 ? len + stop : Math.min(stop, len - 1);
    if (e < s) return [];
    return list.slice(s, e + 1);
  }
  async lrem(key, count, value) {
    const list = this.lists.get(key);
    if (!list) return 0;
    const target = String(value);
    let removed = 0;
    let next;
    if (count === 0) {
      next = list.filter((v) => (v === target ? (removed++, false) : true));
    } else if (count > 0) {
      next = [];
      for (const v of list) {
        if (v === target && removed < count) { removed++; continue; }
        next.push(v);
      }
    } else {
      const limit = -count;
      next = [];
      for (let i = list.length - 1; i >= 0; i--) {
        const v = list[i];
        if (v === target && removed < limit) { removed++; continue; }
        next.unshift(v);
      }
    }
    this.lists.set(key, next);
    return removed;
  }
  async ltrim(key, start, stop) {
    const list = this.lists.get(key) || [];
    const len = list.length;
    if (len === 0) { this.lists.set(key, []); return 'OK'; }
    const s = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
    const e = stop < 0 ? len + stop : Math.min(stop, len - 1);
    this.lists.set(key, e < s ? [] : list.slice(s, e + 1));
    return 'OK';
  }
  async sadd(key, ...members) {
    if (!this.sets.has(key)) this.sets.set(key, new Set());
    const set = this.sets.get(key);
    let added = 0;
    for (const m of members) { if (!set.has(m)) { set.add(m); added++; } }
    return added;
  }
  async smembers(key) { return Array.from(this.sets.get(key) || []); }
  async expire(key, seconds) {
    return (this.store.has(key) || this.sets.has(key) || this.lists.has(key)) ? 1 : 0;
  }
}

// Patch the Redis-client boundary BEFORE anything that calls
// getRedisClient() at its own module-load time is required — every real
// module below binds to this exact same fakeRedis instance.
const redisClientLib = require('../redisClient');
const fakeRedis = new FakeRedis();
redisClientLib.getRedisClient = () => fakeRedis;

// Real service modules — none of these four are mocked anywhere in this
// file, per the approved scope.
const reportService = require('../reportService');
const shareService = require('../shareService');
const creatorBlockLib = require('../creatorBlock');
const adminSessionLib = require('../adminSession');
const { DEFAULT_TTL_SECONDS } = require('../shareConstants');

// Rate limiting — the one explicitly-justified exception, see header.
const rateLimit = require('../rateLimit');
rateLimit.checkAdminRateLimit = async () => ({ success: true });
rateLimit.checkAdminUiLoginRateLimit = async () => ({ success: true });

// Real route handlers, required after the patches above so they share
// the same already-fakeRedis-bound, already-rate-limit-stubbed modules
// via Node's require cache.
const loginHandler = require('../../api/admin-ui/login.js');
const dismissHandler = require('../../api/admin-ui/dismiss-report.js');
const takedownHandler = require('../../api/admin-ui/takedown.js');
const blockCreatorHandler = require('../../api/admin-ui/block-creator.js');

function makeReq({ method = 'POST', body = {}, headers = {} } = {}) {
  return { method, body, headers, query: {} };
}
function makeRes() {
  const res = { statusCode: null, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  return res;
}
// Extracts just the "name=value" pair a browser would echo back as its
// Cookie request header from a real Set-Cookie response header — proves
// the actual cookie this file's own login step produced is usable, not
// a stand-in string.
function cookiePairFrom(setCookieHeader) {
  return setCookieHeader.split(';')[0];
}

// One shared FakeRedis instance for the ENTIRE file, deliberately never
// cleared between tests (no beforeEach reset) — this is one continuous
// workflow, same as a real operator's Redis would accumulate state
// across many actions in one sitting, not a fresh database per action.
// Each scenario below uses its own uniquely-named synthetic shareId/
// token/report so scenarios stay independent despite the shared store.

let sessionCookie; // set by the login test below, reused by every authenticated test after it

// ── 1. Real login -> real session cookie -> used to authenticate a real moderation request ──

test('login: real password check creates a real session; the resulting cookie authenticates a real moderation request', async () => {
  const loginReq = makeReq({ body: { password: 'integration-test-password' } });
  const loginRes = makeRes();
  await loginHandler(loginReq, loginRes);
  assert.equal(loginRes.statusCode, 200);
  assert.match(loginRes.headers['Set-Cookie'], /admin_session=/);

  sessionCookie = cookiePairFrom(loginRes.headers['Set-Cookie']);

  // Prove the cookie is real and actually accepted by a real moderation
  // route, not just well-formed: dismiss a report that doesn't exist.
  // dismiss-report.js never 400s on an unknown reportId (resolveReport is
  // documented as a harmless no-op), so a 200 here specifically proves
  // the SESSION layer accepted the request, isolating what this
  // assertion is actually checking.
  const probeReq = makeReq({
    body: { reportId: 'login-probe-nonexistent-report' },
    headers: { cookie: sessionCookie, [adminSessionLib.CSRF_HEADER_NAME]: '1' },
  });
  const probeRes = makeRes();
  await dismissHandler(probeReq, probeRes);
  assert.equal(probeRes.statusCode, 200);
});

// ── 2. Dismiss: report resolved, share remains available ──

test('dismiss workflow: resolves the report; the shared content remains available and the creator is never touched', async () => {
  const { shareId } = await shareService.createShare({ synthetic: true, label: 'dismiss-workflow-test-share' });
  const { reportId } = await reportService.createReport({ shareId, reason: 'spam', details: 'synthetic test report for Dismiss' });

  assert.equal((await reportService.listOpenReports()).some((r) => r.reportId === reportId), true);

  const req = makeReq({
    body: { reportId },
    headers: { cookie: sessionCookie, [adminSessionLib.CSRF_HEADER_NAME]: '1' },
  });
  const res = makeRes();
  await dismissHandler(req, res);
  assert.equal(res.statusCode, 200);

  // Report resolved: no longer open.
  assert.equal((await reportService.listOpenReports()).some((r) => r.reportId === reportId), false);

  // Share content untouched: still retrievable with its original payload.
  const share = await shareService.getShare(shareId);
  assert.deepEqual(share, { synthetic: true, label: 'dismiss-workflow-test-share' });
});

// ── 3. Take down: share removed, report resolved ──

test('takedown workflow: the share is no longer retrievable and the triggering report is resolved', async () => {
  const { shareId } = await shareService.createShare({ synthetic: true, label: 'takedown-workflow-test-share' });
  const { reportId } = await reportService.createReport({ shareId, reason: 'harassment', details: 'synthetic test report for Take down' });

  const req = makeReq({
    body: { shareId, reportId },
    headers: { cookie: sessionCookie, [adminSessionLib.CSRF_HEADER_NAME]: '1' },
  });
  const res = makeRes();
  await takedownHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deleted, true);

  assert.equal(await shareService.getShare(shareId), null);
  assert.equal((await reportService.listOpenReports()).some((r) => r.reportId === reportId), false);
});

test('takedown workflow: invalid, missing, or already-removed shares are handled safely', async () => {
  // Missing shareId -> 400, nothing touched.
  const missingReq = makeReq({ body: {}, headers: { cookie: sessionCookie, [adminSessionLib.CSRF_HEADER_NAME]: '1' } });
  const missingRes = makeRes();
  await takedownHandler(missingReq, missingRes);
  assert.equal(missingRes.statusCode, 400);

  // A shareId that was never created: deleteShare's real del() returns 0
  // deleted -> `deleted: false`, 200, not an error — matches
  // shareService.deleteShare's own documented contract.
  const neverExistedReq = makeReq({ body: { shareId: 'never-existed-share' }, headers: { cookie: sessionCookie, [adminSessionLib.CSRF_HEADER_NAME]: '1' } });
  const neverExistedRes = makeRes();
  await takedownHandler(neverExistedReq, neverExistedRes);
  assert.equal(neverExistedRes.statusCode, 200);
  assert.equal(neverExistedRes.body.deleted, false);

  // Taking the SAME already-removed share down again is also safe.
  const { shareId } = await shareService.createShare({ synthetic: true, label: 'already-removed-share' });
  await shareService.deleteShare(shareId); // pre-remove it directly via the real service
  const alreadyGoneReq = makeReq({ body: { shareId }, headers: { cookie: sessionCookie, [adminSessionLib.CSRF_HEADER_NAME]: '1' } });
  const alreadyGoneRes = makeRes();
  await takedownHandler(alreadyGoneReq, alreadyGoneRes);
  assert.equal(alreadyGoneRes.statusCode, 200);
  assert.equal(alreadyGoneRes.body.deleted, false);
});

// ── 4. Block Creator: real creator-token flow, real block, real sweep ──

test('block-creator workflow: blocks the creator, resolves the triggering report, disables every share recorded for that token, and future shares from it are rejected', async () => {
  const token = 'synthetic-creator-token-block-test';

  const shareA = await shareService.createShare({ synthetic: true, label: 'block-workflow-share-A-reported' });
  await creatorBlockLib.recordShareCreator(shareA.shareId, token, DEFAULT_TTL_SECONDS);

  const shareB = await shareService.createShare({ synthetic: true, label: 'block-workflow-share-B-sibling' });
  await creatorBlockLib.recordShareCreator(shareB.shareId, token, DEFAULT_TTL_SECONDS);

  const { reportId } = await reportService.createReport({ shareId: shareA.shareId, reason: 'sexual_content', details: 'synthetic test report for Block Creator' });

  // Sanity check on the real setup before acting: the token is not
  // blocked yet, and a hypothetical new share from it would be allowed.
  assert.equal(await creatorBlockLib.isCreatorBlocked(token), false);

  const req = makeReq({
    body: { shareId: shareA.shareId, reportId },
    headers: { cookie: sessionCookie, [adminSessionLib.CSRF_HEADER_NAME]: '1' },
  });
  const res = makeRes();
  await blockCreatorHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.blocked, true);
  // Both shares recorded under this token are swept — recordShareCreator
  // adds the triggering share to the SAME creator-shares set as any
  // sibling, so blockCreatorForShare's enumeration disables both,
  // including the one that was just reported — confirmed by reading
  // lib/creatorBlock.js, not assumed.
  assert.equal(res.body.disabledShareCount, 2);

  // The reported share and its sibling are both gone.
  assert.equal(await shareService.getShare(shareA.shareId), null);
  assert.equal(await shareService.getShare(shareB.shareId), null);

  // The triggering report is resolved.
  assert.equal((await reportService.listOpenReports()).some((r) => r.reportId === reportId), false);

  // Future shares from this token would now be rejected — this is the
  // real, same check api/share/index.js performs before createShare; it
  // is not in this file's required-real set, so verified at the exact
  // service boundary it actually calls, rather than re-implementing the
  // route here.
  assert.equal(await creatorBlockLib.isCreatorBlocked(token), true);
});

test('block-creator workflow: a share with no creator token returns blocked:false and leaves the report open', async () => {
  // Deliberately never call recordShareCreator — simulates an app
  // version that never sent a creator token at all.
  const { shareId } = await shareService.createShare({ synthetic: true, label: 'block-workflow-no-token-share' });
  const { reportId } = await reportService.createReport({ shareId, reason: 'other', details: 'synthetic test report, no creator token' });

  const req = makeReq({
    body: { shareId, reportId },
    headers: { cookie: sessionCookie, [adminSessionLib.CSRF_HEADER_NAME]: '1' },
  });
  const res = makeRes();
  await blockCreatorHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.blocked, false);
  assert.match(res.body.reason, /No creator token/);

  // Nothing was actually done, so the report stays open for a human to
  // act on by another means (e.g. Take down) — this is the real,
  // unmocked confirmation of the gating this file's own Stage 2 fix
  // added to api/admin-ui/block-creator.js.
  assert.equal((await reportService.listOpenReports()).some((r) => r.reportId === reportId), true);

  // The share itself is untouched either.
  const share = await shareService.getShare(shareId);
  assert.deepEqual(share, { synthetic: true, label: 'block-workflow-no-token-share' });
});

// ── 5. Security/failure cases ──

test('security: an unauthenticated request (no cookie at all) is rejected by the real session guard', async () => {
  const req = makeReq({ body: { reportId: 'does-not-matter' }, headers: { [adminSessionLib.CSRF_HEADER_NAME]: '1' } });
  const res = makeRes();
  await dismissHandler(req, res);
  assert.equal(res.statusCode, 401);
});

test('security: an invalid/garbage session cookie is rejected by the real session guard', async () => {
  const req = makeReq({
    body: { shareId: 'does-not-matter' },
    headers: { cookie: 'admin_session=totally-made-up-session-id', [adminSessionLib.CSRF_HEADER_NAME]: '1' },
  });
  const res = makeRes();
  await takedownHandler(req, res);
  assert.equal(res.statusCode, 401);
});

test('security: a real, valid session without the CSRF header is rejected with 403, not treated as authenticated', async () => {
  const req = makeReq({ body: { shareId: 'does-not-matter' }, headers: { cookie: sessionCookie } }); // no CSRF header
  const res = makeRes();
  await takedownHandler(req, res);
  assert.equal(res.statusCode, 403);
});

test('security: a logged-out (destroyed) session can no longer authenticate any of the three actions', async () => {
  const id = sessionCookie.split('=')[1];
  await adminSessionLib.destroySession(id); // real destroy, same as api/admin-ui/logout.js would trigger

  const csrf = { [adminSessionLib.CSRF_HEADER_NAME]: '1' };
  const cookie = sessionCookie;

  const dismissRes = makeRes();
  await dismissHandler(makeReq({ body: { reportId: 'x' }, headers: { cookie, ...csrf } }), dismissRes);
  assert.equal(dismissRes.statusCode, 401);

  const takedownRes = makeRes();
  await takedownHandler(makeReq({ body: { shareId: 'x' }, headers: { cookie, ...csrf } }), takedownRes);
  assert.equal(takedownRes.statusCode, 401);

  const blockRes = makeRes();
  await blockCreatorHandler(makeReq({ body: { shareId: 'x' }, headers: { cookie, ...csrf } }), blockRes);
  assert.equal(blockRes.statusCode, 401);
});
