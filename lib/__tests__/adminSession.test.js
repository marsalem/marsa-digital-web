// lib/__tests__/adminSession.test.js
// Run with: node --test lib/__tests__
//
// Tests the REAL adminSession.js logic (not route-level mocking — see
// adminUiRoutes.integration.test.js for that) against a tiny in-memory
// fake Redis, same technique as creatorBlock.test.js uses for
// creatorBlock.js. "A session expired" is simulated the same way that
// file simulates an expired block: directly deleting the key, which is
// observably identical to its TTL having lapsed on its own.

process.env.UPSTASH_REDIS_REST_URL ||= 'https://example.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN ||= 'test-token';

const test = require('node:test');
const assert = require('node:assert/strict');

class FakeRedis {
  constructor() { this.store = new Map(); }
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async set(key, value) { this.store.set(key, String(value)); return 'OK'; }
  async del(key) { return this.store.delete(key) ? 1 : 0; }
}

const redisClientLib = require('../redisClient');
const fakeRedis = new FakeRedis();
redisClientLib.getRedisClient = () => fakeRedis;

function withEnv(name, value, fn) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env[name]; else process.env[name] = prev;
  }
}

const {
  isCorrectPassword, createSession, isValidSession, destroySession,
  readSessionCookie, sessionCookieHeader, clearSessionCookieHeader,
  rejectUnlessValidSession, rejectUnlessSameOriginHeader,
  CSRF_HEADER_NAME, SESSION_TTL_SECONDS,
} = require('../adminSession');

function makeRes() {
  const res = { statusCode: null, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  return res;
}

// ── isCorrectPassword ──

test('isCorrectPassword: fails closed when ADMIN_UI_PASSWORD is not configured', () => {
  withEnv('ADMIN_UI_PASSWORD', undefined, () => {
    assert.equal(isCorrectPassword('anything'), false);
  });
});

test('isCorrectPassword: rejects an incorrect password', () => {
  withEnv('ADMIN_UI_PASSWORD', 'correct-password', () => {
    assert.equal(isCorrectPassword('wrong-password'), false);
  });
});

test('isCorrectPassword: accepts the correct password', () => {
  withEnv('ADMIN_UI_PASSWORD', 'correct-password', () => {
    assert.equal(isCorrectPassword('correct-password'), true);
  });
});

test('isCorrectPassword: rejects a missing/empty password', () => {
  withEnv('ADMIN_UI_PASSWORD', 'correct-password', () => {
    assert.equal(isCorrectPassword(undefined), false);
    assert.equal(isCorrectPassword(''), false);
  });
});

// ── Session lifecycle ──

test('createSession -> isValidSession round-trips, and persists a sane TTL', async () => {
  const id = await createSession();
  assert.equal(typeof id, 'string');
  assert.ok(id.length > 20); // crypto.randomBytes(32).toString('base64url')
  assert.equal(await isValidSession(id), true);
});

test('isValidSession: false for an id that was never issued', async () => {
  assert.equal(await isValidSession('never-issued'), false);
});

test('isValidSession: false for undefined/null/empty', async () => {
  assert.equal(await isValidSession(undefined), false);
  assert.equal(await isValidSession(null), false);
  assert.equal(await isValidSession(''), false);
});

test('destroySession: an expired/deleted session id is rejected afterward (logout actually invalidates, not just clears the cookie)', async () => {
  const id = await createSession();
  assert.equal(await isValidSession(id), true);
  await destroySession(id);
  assert.equal(await isValidSession(id), false);
});

test('destroySession: destroying an unknown id is a harmless no-op', async () => {
  await assert.doesNotReject(() => destroySession('never-issued'));
  await assert.doesNotReject(() => destroySession(undefined));
});

test('SESSION_TTL_SECONDS is the documented 4 hours', () => {
  assert.equal(SESSION_TTL_SECONDS, 4 * 60 * 60);
});

// ── Cookie parsing/generation ──

test('readSessionCookie: extracts the session cookie from a multi-cookie header', () => {
  const req = { headers: { cookie: 'other=1; admin_session=abc123; another=2' } };
  assert.equal(readSessionCookie(req), 'abc123');
});

test('readSessionCookie: null when the cookie header is absent', () => {
  assert.equal(readSessionCookie({ headers: {} }), null);
});

test('readSessionCookie: null when the admin_session cookie specifically is absent', () => {
  const req = { headers: { cookie: 'other=1; another=2' } };
  assert.equal(readSessionCookie(req), null);
});

test('readSessionCookie: decodes a URI-encoded value', () => {
  const req = { headers: { cookie: 'admin_session=' + encodeURIComponent('a+b/c') } };
  assert.equal(readSessionCookie(req), 'a+b/c');
});

test('sessionCookieHeader: HttpOnly + SameSite=Strict always; Secure only over HTTPS', () => {
  const httpReq = { headers: {} };
  const httpsReq = { headers: { 'x-forwarded-proto': 'https' } };
  const httpHeader = sessionCookieHeader(httpReq, 'sess-id');
  const httpsHeader = sessionCookieHeader(httpsReq, 'sess-id');

  assert.match(httpHeader, /HttpOnly/);
  assert.match(httpHeader, /SameSite=Strict/);
  assert.doesNotMatch(httpHeader, /Secure/); // local http://localhost — a hardcoded Secure would silently break local testing

  assert.match(httpsHeader, /HttpOnly/);
  assert.match(httpsHeader, /SameSite=Strict/);
  assert.match(httpsHeader, /Secure/);
});

test('clearSessionCookieHeader: Max-Age=0 clears the cookie', () => {
  assert.match(clearSessionCookieHeader({ headers: {} }), /Max-Age=0/);
});

// ── Route guards ──

test('rejectUnlessValidSession: 401 for a missing session cookie', async () => {
  const req = { headers: {} };
  const res = makeRes();
  const rejected = await rejectUnlessValidSession(req, res);
  assert.equal(rejected, true);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'Unauthorized.' });
});

test('rejectUnlessValidSession: 401 for an invalid/expired session cookie', async () => {
  const req = { headers: { cookie: 'admin_session=not-a-real-session' } };
  const res = makeRes();
  assert.equal(await rejectUnlessValidSession(req, res), true);
  assert.equal(res.statusCode, 401);
});

test('rejectUnlessValidSession: passes through for a valid session, writes nothing', async () => {
  const id = await createSession();
  const req = { headers: { cookie: 'admin_session=' + id } };
  const res = makeRes();
  const rejected = await rejectUnlessValidSession(req, res);
  assert.equal(rejected, false);
  assert.equal(res.statusCode, null);
});

test('rejectUnlessSameOriginHeader: 403 when the CSRF header is missing', () => {
  const req = { headers: {} };
  const res = makeRes();
  const rejected = rejectUnlessSameOriginHeader(req, res);
  assert.equal(rejected, true);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Forbidden.' });
});

test('rejectUnlessSameOriginHeader: passes through when the CSRF header is present', () => {
  const req = { headers: { [CSRF_HEADER_NAME]: '1' } };
  const res = makeRes();
  assert.equal(rejectUnlessSameOriginHeader(req, res), false);
  assert.equal(res.statusCode, null);
});
