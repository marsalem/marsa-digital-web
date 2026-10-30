// lib/__tests__/adminUiRoutes.integration.test.js
// Run with: node --test lib/__tests__
//
// Integration tests for the admin moderation UI's own backend
// (api/admin-ui/*.js) — same monkey-patch-before-first-require technique
// as reportAndAdmin.integration.test.js: patch the service-module
// exports (reportService, shareService, creatorBlock, adminSession,
// rateLimit) on their cached module objects before requiring the route
// handlers, so no real Redis connection is needed and the actual route
// wiring (session/CSRF gating, rate limiting, request validation,
// response shape) is exercised for real. api/admin/*.js (the
// Bearer-token routes) are untouched by this file and this feature.
//
// SCOPE NOTE ON "SAFE RENDERING": the actual XSS defense for
// reporter-controlled `details` text lives in quran-atlas/admin.html's
// client-side JS, which builds DOM nodes via textContent (never
// innerHTML with interpolated data) — see that file's own comment. That
// is a BROWSER behavior this Node-based suite cannot exercise directly;
// no jsdom or similar dependency was added for this (out of the approved
// scope). What IS verified here, server-side: the admin-ui reports
// endpoint returns a malicious `details` string completely unmodified
// (proving the server doesn't need to, and doesn't, alter it — safety is
// enforced entirely at the rendering boundary, not by mutating data in
// transit). Actual in-browser verification that the page never executes
// injected markup has NOT been performed as of this test file and should
// be done manually (or with a browser-based test added later) before
// relying on this as a complete XSS guarantee.

process.env.UPSTASH_REDIS_REST_URL ||= 'https://example.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN ||= 'test-token';
process.env.ADMIN_UI_PASSWORD = 'test-ui-password';

const test = require('node:test');
const assert = require('node:assert/strict');

const reportService = require('../reportService');
const creatorBlockLib = require('../creatorBlock');
const shareService = require('../shareService');
const rateLimit = require('../rateLimit');
const adminSessionLib = require('../adminSession');
const { MAX_SHARE_ID_LENGTH } = require('../shareConstants');

const MALICIOUS_DETAILS = '<script>alert(1)</script><img src=x onerror=alert(2)>';

let resolveReportCalls = [];
let deleteShareCalls = [];
let blockCreatorCalls = [];
let adminRateLimitOk = true;
let loginRateLimitOk = true;
let loginRateLimitThrows = false;
let validSessionIds = new Set();
let destroySessionCalls = [];

reportService.listOpenReports = async () => ([
  { reportId: 'r1', shareId: 's1', reason: 'spam', details: '', createdAt: 1000 },
  { reportId: 'r2', shareId: 's2', reason: 'other', details: MALICIOUS_DETAILS, createdAt: 2000 },
]);
reportService.getReport = async (reportId) => {
  if (reportId === 'matching-report') return { reportId, shareId: 'share-to-remove', reason: 'spam', details: '', createdAt: 1 };
  if (reportId === 'report-for-no-token-share') return { reportId, shareId: 'share-with-no-token', reason: 'spam', details: '', createdAt: 1 };
  return null;
};
reportService.resolveReport = async (reportId) => { resolveReportCalls.push(reportId); };

shareService.deleteShare = async (shareId) => { deleteShareCalls.push(shareId); return true; };

creatorBlockLib.blockCreatorForShare = async (shareId) => {
  blockCreatorCalls.push(shareId);
  if (shareId === 'share-with-no-token') return { blocked: false, reason: 'No creator token is associated with this share.' };
  return { blocked: true, disabledShareCount: 2 };
};

rateLimit.checkAdminRateLimit = async () => ({ success: adminRateLimitOk });
rateLimit.checkAdminUiLoginRateLimit = async () => {
  if (loginRateLimitThrows) throw new Error('fetch failed: getaddrinfo ENOTFOUND (simulated Redis outage)');
  return { success: loginRateLimitOk };
};

// adminSession's own logic is covered for real in adminSession.test.js —
// here it's mocked at the route-integration level so these tests isolate
// route wiring (status codes, which lib function gets called, response
// shape) from session/cookie mechanics.
adminSessionLib.isCorrectPassword = (password) => password === 'correct-password';
adminSessionLib.createSession = async () => { const id = 'session-' + Math.random(); validSessionIds.add(id); return id; };
adminSessionLib.destroySession = async (id) => { destroySessionCalls.push(id); validSessionIds.delete(id); };
adminSessionLib.readSessionCookie = (req) => {
  const header = req.headers['cookie'];
  if (!header) return null;
  const match = String(header).match(/admin_session=([^;]+)/);
  return match ? match[1] : null;
};
adminSessionLib.sessionCookieHeader = (req, id) => `admin_session=${id}; HttpOnly; SameSite=Strict`;
adminSessionLib.clearSessionCookieHeader = () => 'admin_session=; Max-Age=0';
adminSessionLib.rejectUnlessValidSession = async (req, res) => {
  const id = adminSessionLib.readSessionCookie(req);
  if (id && validSessionIds.has(id)) return false;
  res.status(401).json({ error: 'Unauthorized.' });
  return true;
};
adminSessionLib.rejectUnlessSameOriginHeader = (req, res) => {
  if (req.headers['x-admin-ui-request']) return false;
  res.status(403).json({ error: 'Forbidden.' });
  return true;
};

const loginHandler = require('../../api/admin-ui/login.js');
const logoutHandler = require('../../api/admin-ui/logout.js');
const reportsHandler = require('../../api/admin-ui/reports.js');
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
function authedReq(overrides) {
  return makeReq({ headers: { cookie: 'admin_session=good-session', 'x-admin-ui-request': '1' }, ...overrides });
}

test.beforeEach(() => {
  resolveReportCalls = [];
  deleteShareCalls = [];
  blockCreatorCalls = [];
  destroySessionCalls = [];
  adminRateLimitOk = true;
  loginRateLimitOk = true;
  loginRateLimitThrows = false;
  validSessionIds = new Set(['good-session']);
});

// ── POST /api/admin-ui/login ──

test('login: rejects an incorrect password, sets no cookie', async () => {
  const req = makeReq({ body: { password: 'wrong' } });
  const res = makeRes();
  await loginHandler(req, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers['Set-Cookie'], undefined);
});

test('login: accepts the correct password and sets a session cookie', async () => {
  const req = makeReq({ body: { password: 'correct-password' } });
  const res = makeRes();
  await loginHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Set-Cookie'], /admin_session=/);
});

test('login: is rejected by its own dedicated rate limit, independent of the general admin limit', async () => {
  loginRateLimitOk = false;
  adminRateLimitOk = true; // proves THIS limiter is checked, not the general one
  const req = makeReq({ body: { password: 'correct-password' } });
  const res = makeRes();
  await loginHandler(req, res);
  assert.equal(res.statusCode, 429);
});

test('login: fails closed with 503 (not a crash, not a pass-through) when the rate limiter itself cannot be checked — and never reaches the password check', async () => {
  loginRateLimitThrows = true;
  const req = makeReq({ body: { password: 'correct-password' } }); // the CORRECT password — proves this path is reached before credential checking, not after
  const res = makeRes();
  await loginHandler(req, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers['Set-Cookie'], undefined); // no session was ever created
});

test('login: rejects non-POST methods', async () => {
  const req = makeReq({ method: 'GET' });
  const res = makeRes();
  await loginHandler(req, res);
  assert.equal(res.statusCode, 405);
});

// ── POST /api/admin-ui/logout ──

test('logout: requires the CSRF header, same as every other state-changing admin-ui route', async () => {
  const req = makeReq({ headers: { cookie: 'admin_session=good-session' } }); // no x-admin-ui-request
  const res = makeRes();
  await logoutHandler(req, res);
  assert.equal(res.statusCode, 403);
});

test('logout: destroys the session and clears the cookie for a same-origin request', async () => {
  const req = authedReq();
  const res = makeRes();
  await logoutHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(destroySessionCalls, ['good-session']);
  assert.match(res.headers['Set-Cookie'], /Max-Age=0/);
});

test('logout: a session destroyed once is no longer valid for a subsequent authenticated call', async () => {
  await logoutHandler(authedReq(), makeRes());

  const reportsReq = authedReq({ method: 'GET' });
  const res = makeRes();
  await reportsHandler(reportsReq, res);
  assert.equal(res.statusCode, 401);
});

// ── GET /api/admin-ui/reports ──

test('reports: 401 with no session', async () => {
  const req = makeReq({ method: 'GET', headers: {} });
  const res = makeRes();
  await reportsHandler(req, res);
  assert.equal(res.statusCode, 401);
});

test('reports: lists open reports for a valid session, sets Cache-Control: no-store', async () => {
  const req = authedReq({ method: 'GET' });
  const res = makeRes();
  await reportsHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.reports.length, 2);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('reports: a malicious details string round-trips completely unmodified (server does not need to escape it — see this file\'s own SCOPE NOTE)', async () => {
  const req = authedReq({ method: 'GET' });
  const res = makeRes();
  await reportsHandler(req, res);
  const malicious = res.body.reports.find(r => r.reportId === 'r2');
  assert.equal(malicious.details, MALICIOUS_DETAILS);
});

// ── POST /api/admin-ui/dismiss-report ──

test('dismiss-report: 401 with no session', async () => {
  const req = makeReq({ body: { reportId: 'r1' }, headers: { 'x-admin-ui-request': '1' } });
  const res = makeRes();
  await dismissHandler(req, res);
  assert.equal(res.statusCode, 401);
});

test('dismiss-report: 403 with a valid session but no CSRF header', async () => {
  const req = makeReq({ body: { reportId: 'r1' }, headers: { cookie: 'admin_session=good-session' } });
  const res = makeRes();
  await dismissHandler(req, res);
  assert.equal(res.statusCode, 403);
});

test('dismiss-report: resolves the report for an authenticated, same-origin request', async () => {
  const req = authedReq({ body: { reportId: 'r1' } });
  const res = makeRes();
  await dismissHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(resolveReportCalls, ['r1']);
});

test('dismiss-report: rejects a missing reportId', async () => {
  const req = authedReq({ body: {} });
  const res = makeRes();
  await dismissHandler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(resolveReportCalls.length, 0);
});

test('dismiss-report: rejects a non-string reportId', async () => {
  const req = authedReq({ body: { reportId: 12345 } });
  const res = makeRes();
  await dismissHandler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(resolveReportCalls.length, 0);
});

test('dismiss-report: rejects an empty-string reportId', async () => {
  const req = authedReq({ body: { reportId: '' } });
  const res = makeRes();
  await dismissHandler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(resolveReportCalls.length, 0);
});

// ── POST /api/admin-ui/takedown ──

test('takedown: 401 with no session', async () => {
  const req = makeReq({ body: { shareId: 's1' }, headers: { 'x-admin-ui-request': '1' } });
  const res = makeRes();
  await takedownHandler(req, res);
  assert.equal(res.statusCode, 401);
});

test('takedown: deletes the share for an authenticated, same-origin request', async () => {
  const req = authedReq({ body: { shareId: 's1' } });
  const res = makeRes();
  await takedownHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(deleteShareCalls, ['s1']);
});

test('takedown: also resolves a matching report when reportId is provided', async () => {
  const req = authedReq({ body: { shareId: 'share-to-remove', reportId: 'matching-report' } });
  const res = makeRes();
  await takedownHandler(req, res);
  assert.deepEqual(resolveReportCalls, ['matching-report']);
});

test('takedown: rejects a missing shareId', async () => {
  const req = authedReq({ body: {} });
  const res = makeRes();
  await takedownHandler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(deleteShareCalls.length, 0);
});

test('takedown: rejects an empty-string shareId', async () => {
  const req = authedReq({ body: { shareId: '' } });
  const res = makeRes();
  await takedownHandler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(deleteShareCalls.length, 0);
});

test('takedown: rejects a non-string shareId', async () => {
  const req = authedReq({ body: { shareId: 12345 } });
  const res = makeRes();
  await takedownHandler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(deleteShareCalls.length, 0);
});

test('takedown: rejects a shareId longer than MAX_SHARE_ID_LENGTH', async () => {
  const req = authedReq({ body: { shareId: 'a'.repeat(MAX_SHARE_ID_LENGTH + 1) } });
  const res = makeRes();
  await takedownHandler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(deleteShareCalls.length, 0);
});

test('takedown: rejects a non-string reportId when provided', async () => {
  const req = authedReq({ body: { shareId: 's1', reportId: 12345 } });
  const res = makeRes();
  await takedownHandler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(deleteShareCalls.length, 0);
  assert.equal(resolveReportCalls.length, 0);
});

test('takedown: rejects an empty-string reportId when provided', async () => {
  const req = authedReq({ body: { shareId: 's1', reportId: '' } });
  const res = makeRes();
  await takedownHandler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(deleteShareCalls.length, 0);
  assert.equal(resolveReportCalls.length, 0);
});

// ── POST /api/admin-ui/block-creator ──

test('block-creator: 401 with no session', async () => {
  const req = makeReq({ body: { shareId: 's1' }, headers: { 'x-admin-ui-request': '1' } });
  const res = makeRes();
  await blockCreatorHandler(req, res);
  assert.equal(res.statusCode, 401);
});

test('block-creator: 403 with a valid session but no CSRF header', async () => {
  const req = makeReq({ body: { shareId: 's1' }, headers: { cookie: 'admin_session=good-session' } });
  const res = makeRes();
  await blockCreatorHandler(req, res);
  assert.equal(res.statusCode, 403);
});

test('block-creator: blocks for an authenticated, same-origin request', async () => {
  const req = authedReq({ body: { shareId: 's1' } });
  const res = makeRes();
  await blockCreatorHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.blocked, true);
  assert.equal(res.body.disabledShareCount, 2);
});

test('block-creator: the "no creator recorded" case returns blocked:false with a reason, not an error status', async () => {
  const req = authedReq({ body: { shareId: 'share-with-no-token' } });
  const res = makeRes();
  await blockCreatorHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.blocked, false);
  assert.match(res.body.reason, /No creator token/);
});

test('block-creator: also resolves a matching report when reportId is provided and the block succeeded', async () => {
  const req = authedReq({ body: { shareId: 'share-to-remove', reportId: 'matching-report' } });
  const res = makeRes();
  await blockCreatorHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.blocked, true);
  assert.deepEqual(resolveReportCalls, ['matching-report']);
});

test('block-creator: does NOT resolve the report when nothing was actually blocked (no creator token on this share)', async () => {
  const req = authedReq({ body: { shareId: 'share-with-no-token', reportId: 'report-for-no-token-share' } });
  const res = makeRes();
  await blockCreatorHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.blocked, false);
  assert.deepEqual(resolveReportCalls, []);
});

test('block-creator: rejects a missing shareId', async () => {
  const req = authedReq({ body: {} });
  const res = makeRes();
  await blockCreatorHandler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(blockCreatorCalls.length, 0);
});

test('block-creator: rejects an empty-string shareId', async () => {
  const req = authedReq({ body: { shareId: '' } });
  const res = makeRes();
  await blockCreatorHandler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(blockCreatorCalls.length, 0);
});

test('block-creator: rejects a non-string shareId', async () => {
  const req = authedReq({ body: { shareId: 12345 } });
  const res = makeRes();
  await blockCreatorHandler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(blockCreatorCalls.length, 0);
});

test('block-creator: rejects a shareId longer than MAX_SHARE_ID_LENGTH', async () => {
  const req = authedReq({ body: { shareId: 'a'.repeat(MAX_SHARE_ID_LENGTH + 1) } });
  const res = makeRes();
  await blockCreatorHandler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(blockCreatorCalls.length, 0);
});

test('block-creator: rejects a non-string reportId when provided', async () => {
  const req = authedReq({ body: { shareId: 's1', reportId: 12345 } });
  const res = makeRes();
  await blockCreatorHandler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(blockCreatorCalls.length, 0);
  assert.equal(resolveReportCalls.length, 0);
});

test('block-creator: rejects an empty-string reportId when provided', async () => {
  const req = authedReq({ body: { shareId: 's1', reportId: '' } });
  const res = makeRes();
  await blockCreatorHandler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(blockCreatorCalls.length, 0);
  assert.equal(resolveReportCalls.length, 0);
});
