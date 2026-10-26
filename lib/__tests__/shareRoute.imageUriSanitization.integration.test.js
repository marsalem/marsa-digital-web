// lib/__tests__/shareRoute.imageUriSanitization.integration.test.js
// Run with: node --test lib/__tests__
//
// End-to-end test through the REAL POST /api/share and GET /api/share/:id
// handlers — shareService/shareSchema/contentFilter/creatorBlock/
// noteSanitizer all run for real against an in-memory fake Redis (same
// technique as creatorBlock.test.js); only the rate limiter is stubbed
// (Upstash's Ratelimit SDK needs Lua-script-level Redis behavior this
// fake doesn't implement, and isn't what this test is verifying).
//
// This specifically answers the "test through the actual API endpoint
// that bypasses the client builder" requirement: the payload below is a
// hand-built raw object, not produced by app/utils/sharing.ts's own
// buildTopicSharePayload — simulating an app version that predates the
// client-side fix, or any direct caller of this public endpoint.

process.env.UPSTASH_REDIS_REST_URL ||= 'https://example.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN ||= 'test-token';

const test = require('node:test');
const assert = require('node:assert/strict');

class FakeRedis {
  constructor() { this.store = new Map(); this.sets = new Map(); }
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async set(key, value) { this.store.set(key, String(value)); return 'OK'; }
  async del(...keys) {
    let count = 0;
    for (const key of keys) { if (this.store.delete(key)) count++; if (this.sets.delete(key)) count++; }
    return count;
  }
  async sadd(key, ...members) {
    if (!this.sets.has(key)) this.sets.set(key, new Set());
    const set = this.sets.get(key);
    let added = 0;
    for (const m of members) { if (!set.has(m)) { set.add(m); added++; } }
    return added;
  }
  async smembers(key) { return Array.from(this.sets.get(key) || []); }
  async expire() { return 1; }
}

const redisClientLib = require('../redisClient');
const fakeRedis = new FakeRedis();
redisClientLib.getRedisClient = () => fakeRedis;

const rateLimit = require('../rateLimit');
rateLimit.checkCreateShareRateLimit = async () => ({ success: true });
rateLimit.checkReadShareRateLimit = async () => ({ success: true });

const postHandler = require('../../api/share/index.js');
const getHandler = require('../../api/share/[id].js');

function makeReq(method, body) {
  return { method, headers: {}, query: {}, body };
}
function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

async function postThenGet(payload) {
  const postReq = makeReq('POST', payload);
  const postRes = makeRes();
  await postHandler(postReq, postRes);
  if (postRes.statusCode !== 201) return { postRes, getRes: null };
  const getReq = { method: 'GET', headers: {}, query: { id: postRes.body.shareId } };
  const getRes = makeRes();
  await getHandler(getReq, getRes);
  return { postRes, getRes };
}

test('a raw payload (bypassing the client builder) with an image uri is stripped before storage, confirmed by reading it back', async () => {
  const rawPayload = {
    type: 'qatlas_topic', version: 1,
    node: {
      id: 'n1', name: 'Topic', verses: [], children: [],
      note: JSON.stringify([
        { id: 'b1', type: 'image', uri: 'file:///var/mobile/Containers/Data/Application/ABCD/Documents/topicImages/leaked.jpg', width: 800, height: 600, caption: 'A real photo' },
      ]),
    },
  };

  const { postRes, getRes } = await postThenGet(rawPayload);
  assert.equal(postRes.statusCode, 201); // not rejected merely for containing an image uri
  assert.equal(getRes.statusCode, 200);

  const storedBlocks = JSON.parse(getRes.body.node.note);
  assert.equal(storedBlocks[0].uri, ''); // stripped
  assert.equal(storedBlocks[0].caption, 'A real photo'); // everything else preserved
  assert.equal(storedBlocks[0].width, 800);
  assert.equal(storedBlocks[0].height, 600);
});

test('a share with no image blocks round-trips with its note completely unchanged', async () => {
  const textNote = JSON.stringify([{ id: 'b1', type: 'text', text: 'hello, no images here' }]);
  const payload = { type: 'qatlas_topic', version: 1, node: { id: 'n2', name: 'T2', verses: [], children: [], note: textNote } };

  const { postRes, getRes } = await postThenGet(payload);
  assert.equal(postRes.statusCode, 201);
  assert.equal(getRes.statusCode, 200);
  assert.equal(getRes.body.node.note, textNote); // byte-identical, not just equivalent JSON
});

test('a qatlas_topics bundle with image uris nested in multiple children is stripped recursively, end to end', async () => {
  const payload = {
    type: 'qatlas_topics', version: 1,
    node: {
      id: 'bundle_1', name: 'Bundle', verses: [], children: [
        { id: 'a', name: 'A', verses: [], children: [], note: JSON.stringify([{ id: 'ib', type: 'image', uri: 'file:///a.jpg' }]) },
        { id: 'b', name: 'B', verses: [], children: [], note: JSON.stringify([{ id: 'ib2', type: 'image', uri: 'file:///b.jpg' }]) },
      ],
    },
  };

  const { postRes, getRes } = await postThenGet(payload);
  assert.equal(postRes.statusCode, 201);
  const childA = getRes.body.node.children.find((c) => c.id === 'a');
  const childB = getRes.body.node.children.find((c) => c.id === 'b');
  assert.equal(JSON.parse(childA.note)[0].uri, '');
  assert.equal(JSON.parse(childB.note)[0].uri, '');
});

test('a share containing a legitimate http(s) URL in a UrlBlock is never touched by image-uri sanitization', async () => {
  const note = JSON.stringify([{ id: 'u1', type: 'url', url: 'https://example.com/legitimate-article', title: 'An article' }]);
  const payload = { type: 'qatlas_topic', version: 1, node: { id: 'n3', name: 'T3', verses: [], children: [], note } };

  const { postRes, getRes } = await postThenGet(payload);
  assert.equal(postRes.statusCode, 201);
  assert.equal(getRes.body.node.note, note); // completely untouched
});
