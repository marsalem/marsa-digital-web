// lib/__tests__/adminPreview.test.js
// Run with: node --test lib/__tests__
//
// Tests quran-atlas/admin-preview.js — pure parsing/normalization logic
// for the admin dashboard's report-content preview. No DOM, no fetch, no
// Redis; loaded here via its CommonJS export (the same file also runs as
// a plain browser <script>, see its own UMD-guard comment).
//
// SCOPE NOTE: this proves the DATA this module produces is correct and
// bounded. It does NOT prove quran-atlas/admin.html's own DOM-rendering
// layer uses that data safely (textContent-only, never an <img src> from
// a stored uri, etc.) — that requires a real browser, same gap already
// flagged for the existing report table. See the implementation summary
// for the manual browser verification steps still needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const AdminPreview = require('../../quran-atlas/admin-preview.js');

// ── parseNoteBlocks ──

test('parseNoteBlocks: parses a real Block[] JSON array, preserving order', () => {
  const note = JSON.stringify([
    { id: 'b1', type: 'heading', level: 1, text: 'Intro' },
    { id: 'b2', type: 'text', text: 'Body text' },
  ]);
  const blocks = AdminPreview.parseNoteBlocks(note);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].id, 'b1');
  assert.equal(blocks[1].id, 'b2');
});

test('parseNoteBlocks: legacy plain-text note migrates to a single text block', () => {
  const blocks = AdminPreview.parseNoteBlocks('just some old free text');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.equal(blocks[0].text, 'just some old free text');
});

test('parseNoteBlocks: empty/undefined/null note returns []', () => {
  assert.deepEqual(AdminPreview.parseNoteBlocks(''), []);
  assert.deepEqual(AdminPreview.parseNoteBlocks(undefined), []);
  assert.deepEqual(AdminPreview.parseNoteBlocks(null), []);
});

test('parseNoteBlocks: a string starting with "[" that is NOT valid block JSON falls back to legacy text, never throws', () => {
  assert.doesNotThrow(() => AdminPreview.parseNoteBlocks('[not valid json'));
  const blocks = AdminPreview.parseNoteBlocks('[not valid json');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
});

test('parseNoteBlocks: a JSON array of non-block objects (missing id/type) falls back to legacy text', () => {
  const note = JSON.stringify([{ foo: 'bar' }]);
  const blocks = AdminPreview.parseNoteBlocks(note);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
});

test('parseNoteBlocks: a non-string note shaped like {note: "..."} recovers the inner string (corrupted-data case)', () => {
  const blocks = AdminPreview.parseNoteBlocks({ note: 'recovered text', handled: true });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, 'recovered text');
});

test('parseNoteBlocks: a non-string, non-recoverable note returns [] rather than throwing', () => {
  assert.doesNotThrow(() => AdminPreview.parseNoteBlocks(12345));
  assert.deepEqual(AdminPreview.parseNoteBlocks(12345), []);
});

test('parseNoteBlocks: an unknown block type is NOT dropped — passed through for the renderer to show as unsupported', () => {
  const note = JSON.stringify([{ id: 'b1', type: 'some-future-block-type', foo: 'bar' }]);
  const blocks = AdminPreview.parseNoteBlocks(note);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'some-future-block-type');
});

// ── isKnownBlockType ──

test('isKnownBlockType: recognizes every current block type', () => {
  ['heading', 'text', 'ayah', 'hadith', 'table', 'url', 'image', 'mention', 'bulletList', 'numberedList', 'toggle']
    .forEach(t => assert.equal(AdminPreview.isKnownBlockType(t), true, t));
});

test('isKnownBlockType: false for an unrecognized type', () => {
  assert.equal(AdminPreview.isKnownBlockType('something-else'), false);
  assert.equal(AdminPreview.isKnownBlockType(undefined), false);
});

// ── isSafeHttpUrl ──

test('isSafeHttpUrl: true for http/https', () => {
  assert.equal(AdminPreview.isSafeHttpUrl('https://example.com'), true);
  assert.equal(AdminPreview.isSafeHttpUrl('http://example.com'), true);
});

test('isSafeHttpUrl: false for dangerous or unexpected schemes', () => {
  assert.equal(AdminPreview.isSafeHttpUrl('javascript:alert(1)'), false);
  assert.equal(AdminPreview.isSafeHttpUrl('data:text/html,<script>alert(1)</script>'), false);
  assert.equal(AdminPreview.isSafeHttpUrl('file:///etc/passwd'), false);
  assert.equal(AdminPreview.isSafeHttpUrl('vbscript:foo'), false);
});

test('isSafeHttpUrl: false for non-strings/relative paths', () => {
  assert.equal(AdminPreview.isSafeHttpUrl(undefined), false);
  assert.equal(AdminPreview.isSafeHttpUrl(null), false);
  assert.equal(AdminPreview.isSafeHttpUrl('/relative/path'), false);
});

// ── parseTopicNode / bounded tree walk ──

test('parseTopicNode: walks a simple tree, preserving children order', () => {
  const node = {
    id: 't1', name: 'Root', verses: [], children: [
      { id: 'c1', name: 'First child', verses: [], children: [] },
      { id: 'c2', name: 'Second child', verses: [], children: [] },
    ],
  };
  const { tree, truncated } = AdminPreview.parseTopicNode(node);
  assert.equal(truncated, false);
  assert.equal(tree.name, 'Root');
  assert.equal(tree.children.length, 2);
  assert.equal(tree.children[0].name, 'First child');
  assert.equal(tree.children[1].name, 'Second child');
});

test('parseTopicNode: a Node\'s verses/hadiths pass through with their own precomputed label intact', () => {
  const node = {
    id: 't1', name: 'Root',
    verses: [{ id: 'v1', surah: 2, ayah: 255, label: 'Al-Baqarah 2:255' }],
    hadiths: [{ id: 'h1', bookId: 'bukhari', hadithId: 1, label: 'Sahih al-Bukhari #1' }],
    children: [],
  };
  const { tree } = AdminPreview.parseTopicNode(node);
  assert.equal(tree.verses[0].label, 'Al-Baqarah 2:255');
  assert.equal(tree.hadiths[0].label, 'Sahih al-Bukhari #1');
});

test('parseTopicNode: parses note blocks for every node in the tree, not just the root', () => {
  const node = {
    id: 't1', name: 'Root', verses: [], note: JSON.stringify([{ id: 'b1', type: 'text', text: 'root text' }]),
    children: [{ id: 'c1', name: 'Child', verses: [], note: JSON.stringify([{ id: 'b2', type: 'text', text: 'child text' }]), children: [] }],
  };
  const { tree } = AdminPreview.parseTopicNode(node);
  assert.equal(tree.blocks[0].text, 'root text');
  assert.equal(tree.children[0].blocks[0].text, 'child text');
});

test('parseTopicNode: a node deeper than MAX_NODE_DEPTH is truncated, not infinitely recursed', () => {
  let leaf = { id: 'leaf', name: 'leaf', verses: [], children: [] };
  for (let i = 0; i < AdminPreview.MAX_NODE_DEPTH + 10; i++) {
    leaf = { id: 'n' + i, name: 'n' + i, verses: [], children: [leaf] };
  }
  const { tree, truncated } = AdminPreview.parseTopicNode(leaf);
  assert.equal(truncated, true);
  assert.ok(tree); // the root itself still renders
});

test('parseTopicNode: a node with more children than MAX_ARRAY_LENGTH is capped and marked truncated', () => {
  const manyChildren = [];
  for (let i = 0; i < AdminPreview.MAX_ARRAY_LENGTH + 5; i++) {
    manyChildren.push({ id: 'c' + i, name: 'c' + i, verses: [], children: [] });
  }
  const node = { id: 'root', name: 'Root', verses: [], children: manyChildren };
  const { tree, truncated } = AdminPreview.parseTopicNode(node);
  assert.equal(truncated, true);
  assert.equal(tree.children.length, AdminPreview.MAX_ARRAY_LENGTH);
});

test('parseTopicNode: a wide-at-every-level tree exceeding MAX_TOTAL_NODES is truncated even under per-array limits', () => {
  // 100 children, each with 100 children = 10,100 nodes total — over
  // MAX_TOTAL_NODES (5000) despite every single array staying under
  // MAX_ARRAY_LENGTH (1000) individually.
  const node = { id: 'root', name: 'Root', verses: [], children: [] };
  for (let i = 0; i < 100; i++) {
    const child = { id: 'c' + i, name: 'c' + i, verses: [], children: [] };
    for (let j = 0; j < 100; j++) {
      child.children.push({ id: 'c' + i + '_' + j, name: 'leaf', verses: [], children: [] });
    }
    node.children.push(child);
  }
  const { truncated } = AdminPreview.parseTopicNode(node);
  assert.equal(truncated, true);
});

test('parseTopicNode: a malformed/non-object node returns a null tree rather than throwing', () => {
  assert.doesNotThrow(() => AdminPreview.parseTopicNode(null));
  assert.equal(AdminPreview.parseTopicNode(null).tree, null);
  assert.equal(AdminPreview.parseTopicNode('not an object').tree, null);
});

// ── parseSharePayload — all three types + bundles + legacy + unknown ──

test('parseSharePayload: qatlas_topic', () => {
  const payload = { type: 'qatlas_topic', version: 1, node: { id: 't1', name: 'A topic', verses: [], children: [] } };
  const result = AdminPreview.parseSharePayload(payload);
  assert.equal(result.kind, 'topic');
  assert.equal(result.isBundle, false);
  assert.equal(result.result.tree.name, 'A topic');
});

test('parseSharePayload: qatlas_topics (bundle) is recognized as a topic tree, isBundle true', () => {
  const payload = {
    type: 'qatlas_topics', version: 1,
    node: { id: 'bundle_1', name: 'Quran Atlas Topics', verses: [], children: [{ id: 't1', name: 'Real topic', verses: [], children: [] }] },
  };
  const result = AdminPreview.parseSharePayload(payload);
  assert.equal(result.kind, 'topic');
  assert.equal(result.isBundle, true);
  assert.equal(result.result.tree.children[0].name, 'Real topic');
});

test('parseSharePayload: legacy bare-Node shape (no type field) is recognized as a topic', () => {
  const payload = { id: 't1', name: 'Legacy topic', verses: [], children: [] };
  const result = AdminPreview.parseSharePayload(payload);
  assert.equal(result.kind, 'topic');
  assert.equal(result.result.tree.name, 'Legacy topic');
});

test('parseSharePayload: qatlas_card (single)', () => {
  const payload = { type: 'qatlas_card', version: 1, card: { id: 'c1', title: 'A card', titleAr: 'بطاقة', scenario: 's', scenarioAr: 'س', verseRefs: [], color: '#000' } };
  const result = AdminPreview.parseSharePayload(payload);
  assert.equal(result.kind, 'card');
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0].title, 'A card');
});

test('parseSharePayload: qatlas_cards (bundle) preserves order', () => {
  const payload = {
    type: 'qatlas_cards', version: 1,
    cards: [
      { id: 'c1', title: 'First', titleAr: '', scenario: '', scenarioAr: '', verseRefs: [], color: '#000' },
      { id: 'c2', title: 'Second', titleAr: '', scenario: '', scenarioAr: '', verseRefs: [], color: '#000' },
    ],
  };
  const result = AdminPreview.parseSharePayload(payload);
  assert.equal(result.cards.length, 2);
  assert.equal(result.cards[0].title, 'First');
  assert.equal(result.cards[1].title, 'Second');
});

test('parseSharePayload: qatlas_playlist preserves item order', () => {
  const payload = {
    type: 'qatlas_playlist', version: 1,
    playlist: { id: 'p1', name: 'My Playlist', items: [{ surah: 1 }, { surah: 2, ayahStart: 1, ayahEnd: 5 }] },
  };
  const result = AdminPreview.parseSharePayload(payload);
  assert.equal(result.kind, 'playlist');
  assert.equal(result.name, 'My Playlist');
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].surah, 1);
  assert.equal(result.items[1].surah, 2);
});

test('parseSharePayload: unrecognized shape returns kind:"unknown", never throws', () => {
  assert.doesNotThrow(() => AdminPreview.parseSharePayload({ something: 'else' }));
  assert.equal(AdminPreview.parseSharePayload({ something: 'else' }).kind, 'unknown');
  assert.equal(AdminPreview.parseSharePayload(null).kind, 'unknown');
  assert.equal(AdminPreview.parseSharePayload('a string').kind, 'unknown');
  assert.equal(AdminPreview.parseSharePayload(42).kind, 'unknown');
});

// ── Label formatting ──

test('formatVerseRefLabel: prefers an existing label (Topic Node.verses shape)', () => {
  assert.equal(AdminPreview.formatVerseRefLabel({ surah: 2, ayah: 255, label: 'Al-Baqarah 2:255' }), 'Al-Baqarah 2:255');
});

test('formatVerseRefLabel: falls back to a constructed numeric reference (Reference Card verseRefs shape — no label field exists)', () => {
  assert.equal(AdminPreview.formatVerseRefLabel({ surah: 2, ayah: 255 }), 'Surah 2:255');
  assert.equal(AdminPreview.formatVerseRefLabel({ surah: 2, ayah: 255, ayahEnd: 257 }), 'Surah 2:255-257');
});

test('formatHadithRefLabel: prefers an existing label, else constructs bookId + hadithId', () => {
  assert.equal(AdminPreview.formatHadithRefLabel({ bookId: 'bukhari', hadithId: 1, label: 'Sahih al-Bukhari #1' }), 'Sahih al-Bukhari #1');
  assert.equal(AdminPreview.formatHadithRefLabel({ bookId: 'bukhari', hadithId: 1 }), 'bukhari #1');
});

test('formatPlaylistItemLabel: whole-surah, single-ayah, and range cases', () => {
  assert.equal(AdminPreview.formatPlaylistItemLabel({ surah: 1 }), 'Surah 1 (whole surah)');
  assert.equal(AdminPreview.formatPlaylistItemLabel({ surah: 2, ayahStart: 5 }), 'Surah 2:5');
  assert.equal(AdminPreview.formatPlaylistItemLabel({ surah: 2, ayahStart: 5, ayahEnd: 10 }), 'Surah 2:5-10');
  assert.equal(AdminPreview.formatPlaylistItemLabel({ surah: 2, ayahStart: 5, ayahEnd: 10, repeatCount: 3 }), 'Surah 2:5-10 (×3)');
});
