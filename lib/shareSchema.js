// lib/shareSchema.js
// Marsa Digital web — server-side schema validation for POST /api/share.
//
// shareService.js is deliberately payload-shape-agnostic (see its own
// header) — this module is the thing that's supposed to be shape-aware,
// sitting in api/share/index.js BEFORE a payload ever reaches
// shareService.createShare. It validates against the exact envelope shapes
// Quran Atlas's own app/utils/sharing.ts actually produces today
// (qatlas_playlist/qatlas_card/qatlas_cards/qatlas_topic/qatlas_topics,
// plus the legacy bare-Node shape import-preview.js already renders) —
// verified against that file and app/types/models.ts directly, not
// guessed. Anything that doesn't match one of these is rejected outright;
// this is intentionally a whitelist, not a blocklist.
//
// Scope: this module checks SHAPE and STRUCTURAL BOUNDS (types, required
// fields, array length, nesting depth, string length) — never CONTENT. Text
// content (profanity/abuse filtering) is lib/contentFilter.js's job,
// applied separately in api/share/index.js. Keeping these two concerns in
// separate modules means a shape change never needs to touch filtering
// logic and vice versa.
//
// GET /api/share/:id and api/import-preview.js intentionally do NOT run
// payloads back through this module on read — shares created before this
// module existed (including, per import-preview.js's own comment, at least
// one legacy bare-Node shape still in circulation within its 1-year TTL)
// must keep resolving exactly as before. Validation applies to new writes
// only; it narrows what can be CREATED from here on, not what can still be
// READ.
//
// LOGGING DISCIPLINE — same as every other module in this repo: validation
// failure reasons returned by this module are short, generic shape
// descriptions ("node.children exceeds MAX_ARRAY_LENGTH"), never the
// offending field's own value — never log or return the actual content
// being rejected.

const {
  MAX_NODE_DEPTH,
  MAX_ARRAY_LENGTH,
  MAX_TOTAL_NODES,
  MAX_SHORT_STRING_LENGTH,
  MAX_LONG_STRING_LENGTH,
} = require('./shareConstants');

function isString(v) {
  return typeof v === 'string';
}
function isBoundedString(v, maxLen) {
  return typeof v === 'string' && v.length <= maxLen;
}
function isOptionalBoundedString(v, maxLen) {
  return v === undefined || isBoundedString(v, maxLen);
}
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
function isOptionalFiniteNumber(v) {
  return v === undefined || isFiniteNumber(v);
}
function isOptionalBoolean(v) {
  return v === undefined || typeof v === 'boolean';
}
function isBoundedArray(v, maxLen) {
  return Array.isArray(v) && v.length <= maxLen;
}
function isOptionalBoundedArray(v, maxLen) {
  return v === undefined || isBoundedArray(v, maxLen);
}

// Every known Block variant (app/types/models.ts's `Block` union) carries
// at least one free-text field. Rather than exhaustively re-declaring each
// of the ten block shapes here (and silently drifting from models.ts the
// next time a block type is added), this validates Node.note as ONE bounded
// string — it's already serialized JSON or legacy plain text either way
// (see Node.note's own comment in models.ts) — and leaves per-field
// content/shape concerns inside that JSON to the client's own
// getNodeBlocks() parser, which already tolerates malformed/unknown block
// data by design (falls back to treating it as plain text). A bounded
// string is still real protection here: it caps worst-case size
// independent of MAX_PAYLOAD_BYTES and gives lib/contentFilter.js one
// predictable field to scan for free text regardless of which blocks it
// actually contains.
function validateNoteField(note) {
  return isOptionalBoundedString(note, MAX_LONG_STRING_LENGTH);
}

function validateVerse(v) {
  if (v == null || typeof v !== 'object') return false;
  return isBoundedString(v.id, MAX_SHORT_STRING_LENGTH)
    && isFiniteNumber(v.surah)
    && isFiniteNumber(v.ayah)
    && isOptionalFiniteNumber(v.ayahEnd)
    && isBoundedString(v.label, MAX_SHORT_STRING_LENGTH);
}

function validateHadithNodeRef(h) {
  if (h == null || typeof h !== 'object') return false;
  return isBoundedString(h.id, MAX_SHORT_STRING_LENGTH)
    && isBoundedString(h.bookId, MAX_SHORT_STRING_LENGTH)
    && isFiniteNumber(h.hadithId)
    && isBoundedString(h.label, MAX_SHORT_STRING_LENGTH);
}

// Walks a Node tree exactly the same shape import-preview.js's countVerses()
// does, enforcing MAX_NODE_DEPTH/MAX_ARRAY_LENGTH/MAX_TOTAL_NODES as it
// goes — this is the one piece of code in the whole write path that
// actually stops the crafted-deep-chain DoS countVerses() is vulnerable to,
// by refusing to ever let such a payload reach storage in the first place.
//
// `counters` is a single mutable { total: number } shared across the whole
// recursive walk (not reset per branch) — MAX_TOTAL_NODES is a budget
// across the ENTIRE tree, not per-subtree, otherwise a wide-at-every-level
// shape could satisfy the per-branch check while still producing a huge
// total node count overall.
function validateNode(node, depth, counters) {
  if (node == null || typeof node !== 'object') return false;
  if (depth > MAX_NODE_DEPTH) return false;
  counters.total += 1;
  if (counters.total > MAX_TOTAL_NODES) return false;

  if (!isBoundedString(node.id, MAX_SHORT_STRING_LENGTH)) return false;
  if (!isBoundedString(node.name, MAX_SHORT_STRING_LENGTH)) return false;
  if (!isOptionalBoundedString(node.color, MAX_SHORT_STRING_LENGTH)) return false;
  if (!isOptionalFiniteNumber(node.colorIndex)) return false;
  if (!isOptionalFiniteNumber(node.lastModified)) return false;
  if (!isOptionalBoolean(node.nameCustomized)) return false;
  if (!isOptionalBoolean(node.noteCustomized)) return false;
  if (!validateNoteField(node.note)) return false;

  if (!isBoundedArray(node.verses, MAX_ARRAY_LENGTH)) return false;
  for (const v of node.verses) {
    if (!validateVerse(v)) return false;
  }

  if (!isOptionalBoundedArray(node.hadiths, MAX_ARRAY_LENGTH)) return false;
  if (node.hadiths) {
    for (const h of node.hadiths) {
      if (!validateHadithNodeRef(h)) return false;
    }
  }

  if (!isBoundedArray(node.children, MAX_ARRAY_LENGTH)) return false;
  for (const child of node.children) {
    if (!validateNode(child, depth + 1, counters)) return false;
  }

  return true;
}

function validateVerseRef(ref) {
  if (ref == null || typeof ref !== 'object') return false;
  return isFiniteNumber(ref.surah)
    && isFiniteNumber(ref.ayah)
    && isOptionalFiniteNumber(ref.ayahEnd);
}

function validateHadithRef(ref) {
  if (ref == null || typeof ref !== 'object') return false;
  return isBoundedString(ref.bookId, MAX_SHORT_STRING_LENGTH)
    && isFiniteNumber(ref.hadithId);
}

function validateReferenceCard(card) {
  if (card == null || typeof card !== 'object') return false;
  if (!isBoundedString(card.id, MAX_SHORT_STRING_LENGTH)) return false;
  if (!isBoundedString(card.title, MAX_SHORT_STRING_LENGTH)) return false;
  if (!isBoundedString(card.titleAr, MAX_SHORT_STRING_LENGTH)) return false;
  if (!isBoundedString(card.scenario, MAX_LONG_STRING_LENGTH)) return false;
  if (!isBoundedString(card.scenarioAr, MAX_LONG_STRING_LENGTH)) return false;
  if (!isBoundedString(card.color, MAX_SHORT_STRING_LENGTH)) return false;
  if (!isOptionalFiniteNumber(card.lastModified)) return false;

  if (!isBoundedArray(card.verseRefs, MAX_ARRAY_LENGTH)) return false;
  for (const ref of card.verseRefs) {
    if (!validateVerseRef(ref)) return false;
  }

  if (!isOptionalBoundedArray(card.hadithRefs, MAX_ARRAY_LENGTH)) return false;
  if (card.hadithRefs) {
    for (const ref of card.hadithRefs) {
      if (!validateHadithRef(ref)) return false;
    }
  }

  return true;
}

function validatePlaylistItem(item) {
  if (item == null || typeof item !== 'object') return false;
  return isFiniteNumber(item.surah)
    && isOptionalFiniteNumber(item.ayahStart)
    && isOptionalFiniteNumber(item.ayahEnd)
    && isOptionalFiniteNumber(item.repeatCount);
}

function validatePlaylist(playlist) {
  if (playlist == null || typeof playlist !== 'object') return false;
  if (!isBoundedString(playlist.id, MAX_SHORT_STRING_LENGTH)) return false;
  if (!isBoundedString(playlist.name, MAX_SHORT_STRING_LENGTH)) return false;
  if (!isOptionalBoundedString(playlist.starterId, MAX_SHORT_STRING_LENGTH)) return false;
  if (!isOptionalBoolean(playlist.nameCustomized)) return false;
  if (!isFiniteNumber(playlist.createdAt)) return false;
  if (!isOptionalFiniteNumber(playlist.lastModified)) return false;
  if (!isOptionalBoundedString(playlist.artworkId, MAX_SHORT_STRING_LENGTH)) return false;
  if (!isOptionalFiniteNumber(playlist.repeatCount)) return false;
  if (!isOptionalBoolean(playlist.repeatIndefinitely)) return false;

  if (!isBoundedArray(playlist.items, MAX_ARRAY_LENGTH)) return false;
  for (const item of playlist.items) {
    if (!validatePlaylistItem(item)) return false;
  }

  return true;
}

// Legacy bare-Node shape — a topic share with no `type` field at all,
// predating the type-discriminated envelope (see
// app/utils/sharing.ts's parseTopicSharePayload and import-preview.js's own
// "Legacy bare-Node shape" branch, both of which still handle this
// structurally rather than by type). Still accepted here, not just on
// read, because import-preview.js's own comment confirms at least one such
// share exists in storage within its TTL — meaning something, at some
// point, wrote it via this same POST endpoint. Rejecting it now would be
// narrowing past what "preserve legitimate existing share payloads" allows
// for without direct evidence that no current write path can still produce
// it.
function isLegacyBareNodeShape(payload) {
  return payload && typeof payload === 'object'
    && typeof payload.id === 'string'
    && typeof payload.name === 'string'
    && Array.isArray(payload.children)
    && Array.isArray(payload.verses);
}

/**
 * Validates `payload` against one of the known Share Service envelope
 * shapes. Returns `{ valid: true }` or `{ valid: false, reason: string }` —
 * `reason` is a short structural description (shape/field name, never the
 * payload's own content) suitable for a generic 400 response body.
 *
 * @param {unknown} payload
 * @returns {{ valid: true } | { valid: false, reason: string }}
 */
function validateSharePayload(payload) {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, reason: 'Payload must be a JSON object.' };
  }

  if (payload.type === 'qatlas_playlist') {
    if (payload.version !== 1) return { valid: false, reason: 'Unsupported qatlas_playlist version.' };
    if (!validatePlaylist(payload.playlist)) return { valid: false, reason: 'Malformed playlist.' };
    return { valid: true };
  }

  if (payload.type === 'qatlas_card') {
    if (payload.version !== 1) return { valid: false, reason: 'Unsupported qatlas_card version.' };
    if (!validateReferenceCard(payload.card)) return { valid: false, reason: 'Malformed reference card.' };
    return { valid: true };
  }

  if (payload.type === 'qatlas_cards') {
    if (payload.version !== 1) return { valid: false, reason: 'Unsupported qatlas_cards version.' };
    if (!isBoundedArray(payload.cards, MAX_ARRAY_LENGTH)) return { valid: false, reason: 'Malformed reference card bundle.' };
    for (const card of payload.cards) {
      if (!validateReferenceCard(card)) return { valid: false, reason: 'Malformed reference card in bundle.' };
    }
    return { valid: true };
  }

  if (payload.type === 'qatlas_topic' || payload.type === 'qatlas_topics') {
    if (payload.version !== 1) return { valid: false, reason: `Unsupported ${payload.type} version.` };
    const counters = { total: 0 };
    if (!validateNode(payload.node, 0, counters)) return { valid: false, reason: 'Malformed topic node tree.' };
    return { valid: true };
  }

  if (isLegacyBareNodeShape(payload)) {
    const counters = { total: 0 };
    if (!validateNode(payload, 0, counters)) return { valid: false, reason: 'Malformed legacy topic node tree.' };
    return { valid: true };
  }

  return { valid: false, reason: 'Unrecognized payload shape.' };
}

module.exports = { validateSharePayload };
