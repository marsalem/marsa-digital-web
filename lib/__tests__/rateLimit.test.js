// lib/__tests__/rateLimit.test.js
// Run with: node --test lib/__tests__
//
// Tests only clientIp()'s pure header-parsing logic — the part of
// rateLimit.js that determines which bucket a request counts against.
// Does NOT exercise checkCreateShareRateLimit/checkReadShareRateLimit
// themselves, since those call into a real Upstash Redis client
// (getRedisClient() throws without live credentials) — that integration
// is a manual/staging verification step before deploy, not something
// this pure-unit pass fakes a Redis double for.
//
// Requires UPSTASH_REDIS_REST_URL/TOKEN (or an equivalent fallback pair —
// see lib/redisClient.js) to be set to SOME value before this module can
// even be required, since rateLimit.js constructs a Ratelimit client at
// module load time. Set to harmless placeholders here — no real network
// call happens anywhere in this file.
process.env.UPSTASH_REDIS_REST_URL ||= 'https://example.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN ||= 'test-token';

const test = require('node:test');
const assert = require('node:assert/strict');
const { clientIp } = require('../rateLimit');

test('prefers x-vercel-forwarded-for over x-forwarded-for when both present', () => {
  const req = { headers: { 'x-vercel-forwarded-for': '1.2.3.4', 'x-forwarded-for': '9.9.9.9' } };
  assert.equal(clientIp(req), '1.2.3.4');
});

test('falls back to x-forwarded-for when x-vercel-forwarded-for is absent', () => {
  const req = { headers: { 'x-forwarded-for': '5.6.7.8' } };
  assert.equal(clientIp(req), '5.6.7.8');
});

test('takes the LAST entry of a comma-separated chain, not the first', () => {
  const req = { headers: { 'x-forwarded-for': 'client-claimed, 10.0.0.1, 203.0.113.9' } };
  assert.equal(clientIp(req), '203.0.113.9');
});

test('handles an array-valued header (some runtimes normalize duplicate headers to arrays)', () => {
  const req = { headers: { 'x-forwarded-for': ['1.1.1.1', '2.2.2.2'] } };
  assert.equal(clientIp(req), '1.1.1.1');
});

test('returns "unknown" when no IP header is present at all', () => {
  const req = { headers: {} };
  assert.equal(clientIp(req), 'unknown');
});

test('trims whitespace around chain entries', () => {
  const req = { headers: { 'x-forwarded-for': ' 1.2.3.4 ,  5.6.7.8  ' } };
  assert.equal(clientIp(req), '5.6.7.8');
});
