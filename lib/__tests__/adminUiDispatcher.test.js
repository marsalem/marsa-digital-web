// lib/__tests__/adminUiDispatcher.test.js
// Run with: node --test lib/__tests__
//
// Tests api/admin-ui/[action].js — the single consolidated Vercel
// Function added to keep this project under the Hobby plan's
// 12-Serverless-Function cap (15 -> 10; see the implementation plan for
// the exact count). Same monkey-patch-before-first-require technique as
// adminUiRoutes.integration.test.js, which already covers each handler's
// own behavior (session/CSRF gating, rate limiting, validation, error
// handling) in depth — this file's job is narrower and specific to the
// NEW code this refactor actually added: prove the dispatcher routes
// every valid action to the correct handler, rejects unknown actions
// with a generic 404 that leaks nothing about internal structure, and
// that each handler's own pre-existing HTTP-method check still fires
// through the dispatcher exactly as it did as a separate Vercel
// Function.

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

let resolveReportCalls = [];
let deleteShareCalls = [];
let blockCreatorCalls = [];
let validSessionIds = new Set(['good-session']);

reportService.listOpenReports = async () => ([]);
reportService.getReport = async () => null;
reportService.resolveReport = async (reportId) => { resolveReportCalls.push(reportId); };

shareService.deleteShare = async (shareId) => { deleteShareCalls.push(shareId); return true; };

creatorBlockLib.blockCreatorForShare = async (shareId) => {
  blockCreatorCalls.push(shareId);
  return { blocked: true, disabledShareCount: 0 };
};

rateLimit.checkAdminRateLimit = async () => ({ success: true });
rateLimit.checkAdminUiLoginRateLimit = async () => ({ success: true });

adminSessionLib.isCorrectPassword = (password) => password === 'correct-password';
adminSessionLib.createSession = async () => 'session-abc';
adminSessionLib.destroySession = async () => {};
adminSessionLib.readSessionCookie = (req) => {
  const header = req.headers['cookie'];
  if (!header) return null;
  const match = String(header).match(/admin_session=([^;]+)/);
  return match ? match[1] : null;
};
adminSessionLib.sessionCookieHeader = () => 'admin_session=session-abc; HttpOnly; SameSite=Strict';
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

// Required AFTER every mock above, same ordering convention as every
// other integration test in this directory — proves Node's require()
// resolves a literal "[action].js" filename with no special handling
// (the brackets only mean something to Vercel's own router, not to
// Node's module resolution).
const dispatcher = require('../../api/admin-ui/[action].js');

function makeReq({ method = 'POST', query = {}, body = {}, headers = {} } = {}) {
  return { method, query, body, headers };
}
function makeRes() {
  const res = { statusCode: null, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  return res;
}
function authedHeaders() {
  return { cookie: 'admin_session=good-session', 'x-admin-ui-request': '1' };
}

test.beforeEach(() => {
  resolveReportCalls = [];
  deleteShareCalls = [];
  blockCreatorCalls = [];
  validSessionIds = new Set(['good-session']);
});

// ── Each of the six valid actions reaches its correct handler ──

test('dispatcher: action=login routes to the login handler', async () => {
  const req = makeReq({ method: 'POST', query: { action: 'login' }, body: { password: 'correct-password' } });
  const res = makeRes();
  await dispatcher(req, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Set-Cookie'], /admin_session=/);
});

test('dispatcher: action=logout routes to the logout handler', async () => {
  const req = makeReq({ method: 'POST', query: { action: 'logout' }, headers: authedHeaders() });
  const res = makeRes();
  await dispatcher(req, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Set-Cookie'], /Max-Age=0/);
});

test('dispatcher: action=reports routes to the reports handler', async () => {
  const req = makeReq({ method: 'GET', query: { action: 'reports' }, headers: authedHeaders() });
  const res = makeRes();
  await dispatcher(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { reports: [] });
});

test('dispatcher: action=dismiss-report routes to the dismiss-report handler', async () => {
  const req = makeReq({ method: 'POST', query: { action: 'dismiss-report' }, body: { reportId: 'r1' }, headers: authedHeaders() });
  const res = makeRes();
  await dispatcher(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(resolveReportCalls, ['r1']);
});

test('dispatcher: action=takedown routes to the takedown handler', async () => {
  const req = makeReq({ method: 'POST', query: { action: 'takedown' }, body: { shareId: 's1' }, headers: authedHeaders() });
  const res = makeRes();
  await dispatcher(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(deleteShareCalls, ['s1']);
});

test('dispatcher: action=block-creator routes to the block-creator handler', async () => {
  const req = makeReq({ method: 'POST', query: { action: 'block-creator' }, body: { shareId: 's1' }, headers: authedHeaders() });
  const res = makeRes();
  await dispatcher(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(blockCreatorCalls, ['s1']);
});

// ── Unknown / malicious action values ──

test('dispatcher: an unrecognized action returns a generic 404, never leaking internal structure', async () => {
  const req = makeReq({ method: 'GET', query: { action: 'does-not-exist' } });
  const res = makeRes();
  await dispatcher(req, res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'Not found.' });
});

test('dispatcher: prototype-shaped action values ("constructor", "__proto__", "toString") are 404, not accidentally callable', async () => {
  for (const action of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const req = makeReq({ method: 'GET', query: { action } });
    const res = makeRes();
    await dispatcher(req, res);
    assert.equal(res.statusCode, 404, `action=${action} should 404`);
  }
});

test('dispatcher: a missing or non-string action is 404', async () => {
  const noAction = makeRes();
  await dispatcher(makeReq({ method: 'GET', query: {} }), noAction);
  assert.equal(noAction.statusCode, 404);

  const arrayAction = makeRes();
  await dispatcher(makeReq({ method: 'GET', query: { action: ['reports', 'login'] } }), arrayAction);
  assert.equal(arrayAction.statusCode, 404);
});

// ── Each handler's own HTTP-method restriction still fires through the dispatcher ──

test('dispatcher: method restrictions are preserved — GET on a POST-only action still 405s', async () => {
  const req = makeReq({ method: 'GET', query: { action: 'login' } });
  const res = makeRes();
  await dispatcher(req, res);
  assert.equal(res.statusCode, 405);
});

test('dispatcher: method restrictions are preserved — POST on the GET-only reports action still 405s', async () => {
  const req = makeReq({ method: 'POST', query: { action: 'reports' }, headers: authedHeaders() });
  const res = makeRes();
  await dispatcher(req, res);
  assert.equal(res.statusCode, 405);
});
