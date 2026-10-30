// lib/__tests__/noteSanitizer.test.js
// Run with: node --test lib/__tests__
//
// Server-side mirror of app/utils/__tests__/sharing.imageUriStripping.test.ts
// (client-side) — including the caption-stripping follow-up: `caption`
// is removed alongside `uri`, omitted entirely (not set to ''), matching
// the client-side representation exactly. Pure function, no Redis involved.

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeSharePayload } = require('../noteSanitizer');

function imageBlockNote(uri, extra = {}) {
  return JSON.stringify([
    { id: 'b1', type: 'image', uri, width: 800, height: 600, caption: 'A caption', contentPositionY: 30, displayWidthPercent: 75, displayAspectRatio: 1.5, ...extra },
  ]);
}

test('qatlas_topic: clears the uri and omits the caption on a direct ImageBlock, preserving every sizing/crop field', () => {
  const payload = {
    type: 'qatlas_topic', version: 1,
    node: { id: 'n1', name: 'Topic', verses: [], children: [], note: imageBlockNote('file:///var/mobile/Containers/Data/Application/ABCD/Documents/topicImages/pic123.jpg') },
  };
  const sanitized = sanitizeSharePayload(payload);
  const blocks = JSON.parse(sanitized.node.note);
  assert.deepEqual(blocks, [{
    id: 'b1', type: 'image', uri: '',
    width: 800, height: 600,
    contentPositionY: 30, displayWidthPercent: 75, displayAspectRatio: 1.5,
    // no `caption` key — deepEqual fails if one is present.
  }]);
  assert.equal('caption' in blocks[0], false);
});

test('qatlas_topic: strips URIs and captions from nested children, not just the top-level node', () => {
  const payload = {
    type: 'qatlas_topic', version: 1,
    node: {
      id: 'root', name: 'Root', verses: [], note: imageBlockNote('file:///root.jpg'),
      children: [{ id: 'child1', name: 'Subtopic', verses: [], children: [], note: imageBlockNote('file:///child.jpg') }],
    },
  };
  const sanitized = sanitizeSharePayload(payload);
  const rootBlock = JSON.parse(sanitized.node.note)[0];
  const childBlock = JSON.parse(sanitized.node.children[0].note)[0];
  assert.equal(rootBlock.uri, '');
  assert.equal('caption' in rootBlock, false);
  assert.equal(childBlock.uri, '');
  assert.equal('caption' in childBlock, false);
});

test('qatlas_topics (bundle): strips uri+caption recursively through every child topic, including a subtopic nested inside a bundled topic', () => {
  const payload = {
    type: 'qatlas_topics', version: 1,
    node: {
      id: 'bundle_1', name: 'Bundle', verses: [], children: [
        {
          id: 'a', name: 'A', verses: [], note: imageBlockNote('file:///a.jpg'),
          children: [{ id: 'a-sub', name: 'A subtopic', verses: [], children: [], note: imageBlockNote('file:///a-sub.jpg') }],
        },
        { id: 'b', name: 'B', verses: [], children: [], note: undefined },
      ],
    },
  };
  const sanitized = sanitizeSharePayload(payload);
  const childA = sanitized.node.children.find(c => c.id === 'a');
  const childB = sanitized.node.children.find(c => c.id === 'b');
  const blockA = JSON.parse(childA.note)[0];
  const blockASub = JSON.parse(childA.children[0].note)[0];
  assert.equal(blockA.uri, '');
  assert.equal('caption' in blockA, false);
  assert.equal(blockASub.uri, '');
  assert.equal('caption' in blockASub, false);
  assert.equal(childB.note, undefined);
});

test('legacy bare-Node shape (no type field): sanitized the same as qatlas_topic — uri cleared, caption omitted', () => {
  const payload = { id: 'legacy1', name: 'Legacy', verses: [], children: [], note: imageBlockNote('file:///legacy.jpg') };
  const sanitized = sanitizeSharePayload(payload);
  const block = JSON.parse(sanitized.note)[0];
  assert.equal(block.uri, '');
  assert.equal('caption' in block, false);
});

test('does NOT alter a note with no image blocks — exact same string reference', () => {
  const textOnlyNote = JSON.stringify([{ id: 'b1', type: 'text', text: 'Just a reflection, no images.' }]);
  const payload = { type: 'qatlas_topic', version: 1, node: { id: 'n1', name: 'T', verses: [], children: [], note: textOnlyNote } };
  const sanitized = sanitizeSharePayload(payload);
  assert.equal(sanitized.node.note, textOnlyNote); // === reference check, not just deepEqual
});

test('does NOT alter a legacy plain-text note', () => {
  const legacyNote = 'This topic predates the block editor.';
  const payload = { type: 'qatlas_topic', version: 1, node: { id: 'n1', name: 'T', verses: [], children: [], note: legacyNote } };
  const sanitized = sanitizeSharePayload(payload);
  assert.equal(sanitized.node.note, legacyNote);
});

test('does NOT alter a node with no note at all, and returns the SAME payload object when nothing changes anywhere', () => {
  const payload = { type: 'qatlas_topic', version: 1, node: { id: 'n1', name: 'T', verses: [], children: [] } };
  const sanitized = sanitizeSharePayload(payload);
  assert.equal(sanitized, payload); // nothing to do anywhere -> same top-level reference too
});

test('a mix of Ayah/Hadith/Text/Toggle/Image blocks only strips the image block\'s uri+caption, leaving every other block — and every other field, including a non-image block with a similarly-named field — untouched', () => {
  const note = JSON.stringify([
    { id: 'b1', type: 'ayah', surah: 2, ayah: 155, arabic: 'نص آية', english: 'verse text', surahName: 'Al-Baqarah', surahNameAr: 'البقرة' },
    { id: 'b2', type: 'text', text: 'A reflection.' },
    { id: 'b3', type: 'toggle', title: 'Caption', body: 'A toggle block — not an image, must be untouched.' },
    { id: 'b4', type: 'image', uri: 'file:///pic.jpg', caption: 'photo' },
  ]);
  const payload = { type: 'qatlas_topic', version: 1, node: { id: 'n1', name: 'T', verses: [], children: [], note } };
  const sanitized = sanitizeSharePayload(payload);
  const blocks = JSON.parse(sanitized.node.note);
  assert.deepEqual(blocks[0], { id: 'b1', type: 'ayah', surah: 2, ayah: 155, arabic: 'نص آية', english: 'verse text', surahName: 'Al-Baqarah', surahNameAr: 'البقرة' });
  assert.deepEqual(blocks[1], { id: 'b2', type: 'text', text: 'A reflection.' });
  assert.deepEqual(blocks[2], { id: 'b3', type: 'toggle', title: 'Caption', body: 'A toggle block — not an image, must be untouched.' });
  assert.equal(blocks[3].uri, '');
  assert.equal('caption' in blocks[3], false);
});

test('a caption is removed even when the uri is ALREADY empty (uri and caption are checked independently)', () => {
  const note = imageBlockNote(''); // uri already '', caption: 'A caption' (helper default)
  const payload = { type: 'qatlas_topic', version: 1, node: { id: 'n1', name: 'T', verses: [], children: [], note } };
  const sanitized = sanitizeSharePayload(payload);
  assert.notEqual(sanitized.node.note, note); // something DID change — the caption
  const block = JSON.parse(sanitized.node.note)[0];
  assert.equal(block.uri, '');
  assert.equal('caption' in block, false);
});

test('a genuine no-op: uri already empty AND no caption at all — returns the exact same string/object references', () => {
  const note = imageBlockNote('', { caption: undefined }); // overrides the helper's own default caption
  const payload = { type: 'qatlas_topic', version: 1, node: { id: 'n1', name: 'T', verses: [], children: [], note } };
  const sanitized = sanitizeSharePayload(payload);
  assert.equal(sanitized.node.note, note);
  assert.equal(sanitized, payload); // nothing to do anywhere -> same top-level reference too
});

test('never mutates the original payload object, including the caption on the original', () => {
  const originalNote = imageBlockNote('file:///original.jpg');
  const payload = { type: 'qatlas_topic', version: 1, node: { id: 'n1', name: 'T', verses: [], children: [], note: originalNote } };
  sanitizeSharePayload(payload);
  assert.equal(payload.node.note, originalNote);
  const originalBlock = JSON.parse(payload.node.note)[0];
  assert.equal(originalBlock.uri, 'file:///original.jpg');
  assert.equal(originalBlock.caption, 'A caption'); // sanitization is on the OUTPUT only — source untouched
});

test('qatlas_playlist / qatlas_card / qatlas_cards payloads are returned untouched (no Node/note to sanitize)', () => {
  const playlistPayload = { type: 'qatlas_playlist', version: 1, playlist: { id: 'p', name: 'n', items: [], createdAt: 1 } };
  const cardPayload = { type: 'qatlas_card', version: 1, card: { id: 'c', title: 'T', titleAr: 'ت', scenario: 's', scenarioAr: 'س', verseRefs: [], color: '#000' } };
  assert.equal(sanitizeSharePayload(playlistPayload), playlistPayload);
  assert.equal(sanitizeSharePayload(cardPayload), cardPayload);
});

test('never throws on garbage input', () => {
  assert.doesNotThrow(() => sanitizeSharePayload(null));
  assert.doesNotThrow(() => sanitizeSharePayload(undefined));
  assert.doesNotThrow(() => sanitizeSharePayload('a string'));
  assert.doesNotThrow(() => sanitizeSharePayload({ type: 'qatlas_topic', version: 1, node: null }));
});
