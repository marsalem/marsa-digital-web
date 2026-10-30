// lib/__tests__/reportService.test.js
// Run with: node --test lib/__tests__
//
// Tests the REAL reportService.js logic (not route-level mocking — see
// adminUiRoutes.integration.test.js/reportAndAdmin.integration.test.js
// for that) against a tiny in-memory fake Redis, same technique
// adminSession.test.js/creatorBlock.test.js use for their own modules.
// Every admin moderation action (Dismiss, Take down, Block Creator)
// depends on resolveReport/getReport actually working against real
// Redis list/key semantics — this file is what proves that, rather than
// just proving a ROUTE calls the right function name.

process.env.UPSTASH_REDIS_REST_URL ||= 'https://example.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN ||= 'test-token';

const test = require('node:test');
const assert = require('node:assert/strict');

// Faithful to exactly the commands reportService.js actually issues:
// GET/SET for the report:<id> record, and RPUSH/LRANGE/LREM/LTRIM
// against the reports:open and reports:resolved LISTS. Real Redis list-
// index semantics (negative indices counting from the tail, LREM's
// count=0 meaning "remove every occurrence") are implemented for real,
// not stubbed — this is specifically what resolveReport's LREM(0, ...)
// and LTRIM(-500, -1) calls depend on behaving correctly.
class FakeRedis {
  constructor() {
    this.store = new Map(); // key -> string value (report:<id> records)
    this.lists = new Map(); // key -> array of string values (open/resolved lists)
  }
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async set(key, value) { this.store.set(key, String(value)); return 'OK'; } // TTL (3rd arg) ignored, same as this file's sibling fakes
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
}

const redisClientLib = require('../redisClient');
const fakeRedis = new FakeRedis();
redisClientLib.getRedisClient = () => fakeRedis;

const { createReport, listOpenReports, getReport, resolveReport } = require('../reportService');

test.beforeEach(() => {
  fakeRedis.store.clear();
  fakeRedis.lists.clear();
});

// ── createReport / listOpenReports ──

test('createReport: returns a non-empty string reportId', async () => {
  const { reportId } = await createReport({ shareId: 's1', reason: 'spam', details: 'junk' });
  assert.equal(typeof reportId, 'string');
  assert.ok(reportId.length > 0);
});

test('createReport: defaults details to "" when omitted', async () => {
  const { reportId } = await createReport({ shareId: 's1', reason: 'spam' });
  const report = await getReport(reportId);
  assert.equal(report.details, '');
});

test('createReport: the created report appears in listOpenReports', async () => {
  const { reportId } = await createReport({ shareId: 's1', reason: 'spam', details: 'junk' });
  const open = await listOpenReports();
  assert.equal(open.length, 1);
  assert.equal(open[0].reportId, reportId);
  assert.equal(open[0].shareId, 's1');
  assert.equal(open[0].reason, 'spam');
  assert.equal(open[0].details, 'junk');
  assert.equal(typeof open[0].createdAt, 'number');
});

// ── getReport ──

test('getReport: correctly retrieves and deserializes a previously created report', async () => {
  const { reportId } = await createReport({ shareId: 'share-xyz', reason: 'harassment', details: 'details here' });
  const report = await getReport(reportId);
  assert.equal(report.reportId, reportId);
  assert.equal(report.shareId, 'share-xyz');
  assert.equal(report.reason, 'harassment');
  assert.equal(report.details, 'details here');
  assert.equal(typeof report.createdAt, 'number');
});

test('getReport: null for an id that was never created', async () => {
  assert.equal(await getReport('never-created'), null);
});

// ── resolveReport ──

test('resolveReport: removes the report from the open list', async () => {
  const { reportId } = await createReport({ shareId: 's1', reason: 'spam' });
  assert.equal((await listOpenReports()).length, 1);
  await resolveReport(reportId);
  assert.equal((await listOpenReports()).length, 0);
});

test('resolveReport: appends the reportId to the resolved list', async () => {
  const { reportId } = await createReport({ shareId: 's1', reason: 'spam' });
  await resolveReport(reportId);
  const resolved = await fakeRedis.lrange('reports:resolved', 0, -1);
  assert.deepEqual(resolved, [reportId]);
});

test('resolveReport: the underlying report record is untouched (still fetchable via getReport)', async () => {
  const { reportId } = await createReport({ shareId: 's1', reason: 'spam', details: 'd' });
  await resolveReport(reportId);
  const report = await getReport(reportId);
  assert.equal(report.reportId, reportId); // resolution is list-membership only, never a rewrite of the record itself
});

test('resolveReport: resolving the same report twice is a harmless no-op (idempotent — stays resolved, no error)', async () => {
  const { reportId } = await createReport({ shareId: 's1', reason: 'spam' });
  await resolveReport(reportId);
  await assert.doesNotReject(() => resolveReport(reportId));
  assert.equal((await listOpenReports()).length, 0); // stays out of the open list either way
});

test('resolveReport: resolving a reportId that was never created is a harmless no-op', async () => {
  await assert.doesNotReject(() => resolveReport('never-created'));
  assert.equal((await listOpenReports()).length, 0);
});

// ── Resolved-list max length ──

test('resolveReport: the resolved list is trimmed to RESOLVED_LIST_MAX (500), keeping the most recently resolved', async () => {
  for (let i = 0; i < 505; i++) {
    await resolveReport('synthetic-' + i);
  }
  const resolved = await fakeRedis.lrange('reports:resolved', 0, -1);
  assert.equal(resolved.length, 500);
  assert.equal(resolved[0], 'synthetic-5'); // the oldest 5 were trimmed off
  assert.equal(resolved[resolved.length - 1], 'synthetic-504'); // the most recent survives
});

// ── listOpenReports ──

test('listOpenReports: returns only currently-open reports, excluding resolved ones', async () => {
  const a = await createReport({ shareId: 'sa', reason: 'spam' });
  const b = await createReport({ shareId: 'sb', reason: 'other' });
  await resolveReport(a.reportId);
  const open = await listOpenReports();
  assert.equal(open.length, 1);
  assert.equal(open[0].reportId, b.reportId);
});

test('listOpenReports: skips a reportId whose own record has expired/vanished, without throwing', async () => {
  const { reportId } = await createReport({ shareId: 's1', reason: 'spam' });
  fakeRedis.store.delete('report:' + reportId); // simulates TTL expiry — same technique adminSession.test.js uses for session expiry
  const open = await listOpenReports();
  assert.deepEqual(open, []);
});
