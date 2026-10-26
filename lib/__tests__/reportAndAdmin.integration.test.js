// lib/__tests__/reportAndAdmin.integration.test.js
// Run with: node --test lib/__tests__
//
// Integration tests for the full report/takedown/dismiss/block-creator
// workflow — same monkey-patch-before-first-require technique as
// shareRoute.integration.test.js (Stage 2): patch the Redis-backed
// service modules on their cached module objects before requiring the
// route handlers, so no real Redis connection is needed and the route-
// level wiring (auth, validation, rate limiting, response shape) is
// exercised for real.

process.env.UPSTASH_REDIS_REST_URL ||= 'https://example.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN ||= 'test-token';
process.env.ADMIN_API_TOKEN = 'test-admin-token';

const test = require('node:test');
const assert = require('node:assert/strict');

const reportService = require('../reportService');
const creatorBlockLib = require('../creatorBlock');
const shareService = require('../shareService');
const rateLimit = require('../rateLimit');

// ── Fakes, swapped in before each handler is first required ──
let createReportCalls = [];
let resolveReportCalls = [];
let deleteShareCalls = [];
let blockCreatorCalls = [];
let reportRateLimitOk = true;
let adminRateLimitOk = true;

reportService.createReport = async (input) => {
  createReportCalls.push(input);
  return { reportId: 'fake-report-id' };
};
reportService.listOpenReports = async () => ([
  { reportId: 'r1', shareId: 's1', reason: 'spam', details: '', createdAt: 1 },
]);
reportService.getReport = async (reportId) => {
  if (reportId === 'matching-report') return { reportId, shareId: 'share-to-remove', reason: 'spam', details: '', createdAt: 1 };
  if (reportId === 'mismatched-report') return { reportId, shareId: 'a-totally-different-share', reason: 'spam', details: '', createdAt: 1 };
  return null;
};
reportService.resolveReport = async (reportId) => { resolveReportCalls.push(reportId); };

shareService.deleteShare = async (shareId) => { deleteShareCalls.push(shareId); return true; };

creatorBlockLib.blockCreatorForShare = async (shareId) => {
  blockCreatorCalls.push(shareId);
  if (shareId === 'share-with-no-token') return { blocked: false, reason: 'No creator token is associated with this share.' };
  return { blocked: true };
};

rateLimit.checkReportRateLimit = async () => ({ success: reportRateLimitOk });
rateLimit.checkAdminRateLimit = async () => ({ success: adminRateLimitOk });

const reportHandler = require('../../api/report.js');
const adminReportsHandler = require('../../api/admin/reports.js');
const takedownHandler = require('../../api/admin/takedown.js');
const dismissHandler = require('../../api/admin/dismiss-report.js');
const blockCreatorHandler = require('../../api/admin/block-creator.js');

function makeReq({ method = 'POST', body = {}, headers = {} } = {}) {
  return { method, body, headers, query: {} };
}
function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test.beforeEach(() => {
  createReportCalls = [];
  resolveReportCalls = [];
  deleteShareCalls = [];
  blockCreatorCalls = [];
  reportRateLimitOk = true;
  adminRateLimitOk = true;
});

// ── POST /api/report ──

test('report: accepts a valid report and never requires reporter PII', async () => {
  const req = makeReq({ body: { shareId: 'abc123', reason: 'spam', details: 'looks like an ad' } });
  const res = makeRes();
  await reportHandler(req, res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(createReportCalls, [{ shareId: 'abc123', reason: 'spam', details: 'looks like an ad' }]);
});

test('report: details is optional', async () => {
  const req = makeReq({ body: { shareId: 'abc123', reason: 'spam' } });
  const res = makeRes();
  await reportHandler(req, res);
  assert.equal(res.statusCode, 201);
});

test('report: rejects a missing shareId', async () => {
  const req = makeReq({ body: { reason: 'spam' } });
  const res = makeRes();
  await reportHandler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(createReportCalls.length, 0);
});

test('report: rejects an invalid reason', async () => {
  const req = makeReq({ body: { shareId: 'abc123', reason: 'because I feel like it' } });
  const res = makeRes();
  await reportHandler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(createReportCalls.length, 0);
});

test('report: rejects oversized details', async () => {
  const req = makeReq({ body: { shareId: 'abc123', reason: 'spam', details: 'x'.repeat(5000) } });
  const res = makeRes();
  await reportHandler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(createReportCalls.length, 0);
});

test('report: rejects a non-object body', async () => {
  const req = makeReq({ body: 'not an object' });
  const res = makeRes();
  await reportHandler(req, res);
  assert.equal(res.statusCode, 400);
});

test('report: abuse via rate limiting is rejected with 429', async () => {
  reportRateLimitOk = false;
  const req = makeReq({ body: { shareId: 'abc123', reason: 'spam' } });
  const res = makeRes();
  await reportHandler(req, res);
  assert.equal(res.statusCode, 429);
  assert.equal(createReportCalls.length, 0);
});

test('report: rejects non-POST methods', async () => {
  const req = makeReq({ method: 'GET' });
  const res = makeRes();
  await reportHandler(req, res);
  assert.equal(res.statusCode, 405);
});

// ── GET /api/admin/reports — unauthorized takedown-adjacent access ──

test('admin/reports: rejects a request with no admin token', async () => {
  const req = makeReq({ method: 'GET', headers: {} });
  const res = makeRes();
  await adminReportsHandler(req, res);
  assert.equal(res.statusCode, 401);
});

test('admin/reports: rejects a request with the wrong admin token', async () => {
  const req = makeReq({ method: 'GET', headers: { authorization: 'Bearer not-the-right-token' } });
  const res = makeRes();
  await adminReportsHandler(req, res);
  assert.equal(res.statusCode, 401);
});

test('admin/reports: lists open reports for an authorized caller', async () => {
  const req = makeReq({ method: 'GET', headers: { authorization: 'Bearer test-admin-token' } });
  const res = makeRes();
  await adminReportsHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.reports.length, 1);
});

// ── POST /api/admin/takedown ──

test('takedown: unauthorized request is rejected before deleteShare ever runs', async () => {
  const req = makeReq({ headers: {}, body: { shareId: 'share-to-remove' } });
  const res = makeRes();
  await takedownHandler(req, res);
  assert.equal(res.statusCode, 401);
  assert.equal(deleteShareCalls.length, 0);
});

test('takedown: works for a shareId with no associated report', async () => {
  const req = makeReq({ headers: { authorization: 'Bearer test-admin-token' }, body: { shareId: 'share-to-remove' } });
  const res = makeRes();
  await takedownHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(deleteShareCalls, ['share-to-remove']);
  assert.equal(resolveReportCalls.length, 0);
});

test('takedown: also resolves a matching report when reportId is provided', async () => {
  const req = makeReq({
    headers: { authorization: 'Bearer test-admin-token' },
    body: { shareId: 'share-to-remove', reportId: 'matching-report' },
  });
  const res = makeRes();
  await takedownHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(resolveReportCalls, ['matching-report']);
});

test('takedown: does NOT resolve a report whose shareId does not match the one being taken down', async () => {
  const req = makeReq({
    headers: { authorization: 'Bearer test-admin-token' },
    body: { shareId: 'share-to-remove', reportId: 'mismatched-report' },
  });
  const res = makeRes();
  await takedownHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(resolveReportCalls.length, 0);
});

test('takedown: rejects a missing shareId', async () => {
  const req = makeReq({ headers: { authorization: 'Bearer test-admin-token' }, body: {} });
  const res = makeRes();
  await takedownHandler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(deleteShareCalls.length, 0);
});

// ── POST /api/admin/dismiss-report ──

test('dismiss-report: unauthorized request is rejected', async () => {
  const req = makeReq({ headers: {}, body: { reportId: 'r1' } });
  const res = makeRes();
  await dismissHandler(req, res);
  assert.equal(res.statusCode, 401);
  assert.equal(resolveReportCalls.length, 0);
});

test('dismiss-report: resolves the report without touching any share', async () => {
  const req = makeReq({ headers: { authorization: 'Bearer test-admin-token' }, body: { reportId: 'r1' } });
  const res = makeRes();
  await dismissHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(resolveReportCalls, ['r1']);
  assert.equal(deleteShareCalls.length, 0);
});

// ── POST /api/admin/block-creator ──

test('block-creator: unauthorized request is rejected', async () => {
  const req = makeReq({ headers: {}, body: { shareId: 'share-to-remove' } });
  const res = makeRes();
  await blockCreatorHandler(req, res);
  assert.equal(res.statusCode, 401);
  assert.equal(blockCreatorCalls.length, 0);
});

test('block-creator: blocks the creator token associated with the share', async () => {
  const req = makeReq({ headers: { authorization: 'Bearer test-admin-token' }, body: { shareId: 'share-to-remove' } });
  const res = makeRes();
  await blockCreatorHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { blocked: true });
});

test('block-creator: reports blocked:false with a reason when the share has no creator token', async () => {
  const req = makeReq({ headers: { authorization: 'Bearer test-admin-token' }, body: { shareId: 'share-with-no-token' } });
  const res = makeRes();
  await blockCreatorHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.blocked, false);
  assert.equal(typeof res.body.reason, 'string');
});

// ── Admin rate limiting (defense-in-depth on top of the token check) ──

test('admin routes are rate-limited independently of the auth check', async () => {
  adminRateLimitOk = false;
  const req = makeReq({ method: 'GET', headers: { authorization: 'Bearer test-admin-token' } });
  const res = makeRes();
  await adminReportsHandler(req, res);
  assert.equal(res.statusCode, 429);
});
