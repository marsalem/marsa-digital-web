// lib/__tests__/adminAuth.test.js
// Run with: node --test lib/__tests__
// Pure logic, no Redis involved.

const test = require('node:test');
const assert = require('node:assert/strict');
const { isAuthorizedAdmin, rejectUnlessAdmin, timingSafeStringEqual } = require('../adminAuth');

function withEnv(token, fn) {
  const prev = process.env.ADMIN_API_TOKEN;
  if (token === undefined) delete process.env.ADMIN_API_TOKEN;
  else process.env.ADMIN_API_TOKEN = token;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.ADMIN_API_TOKEN;
    else process.env.ADMIN_API_TOKEN = prev;
  }
}

test('timingSafeStringEqual: equal strings', () => {
  assert.equal(timingSafeStringEqual('secret123', 'secret123'), true);
});

test('timingSafeStringEqual: different strings, same length', () => {
  assert.equal(timingSafeStringEqual('secret123', 'secret124'), false);
});

test('timingSafeStringEqual: different lengths never throws', () => {
  assert.doesNotThrow(() => timingSafeStringEqual('short', 'a much longer string'));
  assert.equal(timingSafeStringEqual('short', 'a much longer string'), false);
});

test('isAuthorizedAdmin: fails closed when ADMIN_API_TOKEN is not configured at all', () => {
  withEnv(undefined, () => {
    const req = { headers: { authorization: 'Bearer anything' } };
    assert.equal(isAuthorizedAdmin(req), false);
  });
});

test('isAuthorizedAdmin: rejects a missing Authorization header', () => {
  withEnv('correct-token', () => {
    assert.equal(isAuthorizedAdmin({ headers: {} }), false);
  });
});

test('isAuthorizedAdmin: rejects a header without the Bearer prefix', () => {
  withEnv('correct-token', () => {
    assert.equal(isAuthorizedAdmin({ headers: { authorization: 'correct-token' } }), false);
  });
});

test('isAuthorizedAdmin: rejects an incorrect token', () => {
  withEnv('correct-token', () => {
    assert.equal(isAuthorizedAdmin({ headers: { authorization: 'Bearer wrong-token' } }), false);
  });
});

test('isAuthorizedAdmin: accepts the correct token', () => {
  withEnv('correct-token', () => {
    assert.equal(isAuthorizedAdmin({ headers: { authorization: 'Bearer correct-token' } }), true);
  });
});

test('isAuthorizedAdmin: rejects an empty Bearer value', () => {
  withEnv('correct-token', () => {
    assert.equal(isAuthorizedAdmin({ headers: { authorization: 'Bearer ' } }), false);
  });
});

test('rejectUnlessAdmin: writes a 401 and returns true for an unauthorized request', () => {
  withEnv('correct-token', () => {
    const req = { headers: {} };
    let statusCode = null, body = null;
    const res = { status: (c) => { statusCode = c; return res; }, json: (b) => { body = b; return res; } };
    const rejected = rejectUnlessAdmin(req, res);
    assert.equal(rejected, true);
    assert.equal(statusCode, 401);
    assert.deepEqual(body, { error: 'Unauthorized.' });
  });
});

test('rejectUnlessAdmin: returns false and writes nothing for an authorized request', () => {
  withEnv('correct-token', () => {
    const req = { headers: { authorization: 'Bearer correct-token' } };
    let called = false;
    const res = { status: () => { called = true; return res; }, json: () => res };
    const rejected = rejectUnlessAdmin(req, res);
    assert.equal(rejected, false);
    assert.equal(called, false);
  });
});
