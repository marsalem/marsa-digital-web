// lib/noteSanitizer.js
// Marsa Digital web — server-side backstop for the same finding
// app/utils/sharing.ts's sanitizeNoteForSharing/sanitizeNodeForSharing
// already fix client-side: ImageBlock.uri (app/types/models.ts) is
// ALWAYS a local, already-persisted device file path by contract — "A
// user-picked photo (camera or library) — `uri` is a LOCAL, already-
// persisted file path... never embedded image bytes" (that type's own
// doc comment, verified directly, not assumed) — there is no variant of
// this field that is ever a legitimate hosted URL meant to leave the
// device. Clearing it unconditionally is therefore safe by construction,
// not a heuristic guess at "which URIs look local."
//
// WHY THIS EXISTS DESPITE THE CLIENT-SIDE FIX: `POST /api/share` is
// public and unauthenticated — anyone can call it directly, and an app
// build that predates the client-side fix can still send the raw,
// unstripped uri. The client fix protects every CALLER that goes through
// it; this is the one place that can make the guarantee hold for every
// REQUEST, regardless of caller. Same "server must remain authoritative"
// principle already applied to lib/shareSchema.js and
// lib/contentFilter.js in this codebase — not a new policy.
//
// SCOPE — deliberately narrow, mirroring the client-side algorithm
// exactly: only ever touches a block where `type === 'image'`, and only
// ever clears that one block's own `uri` field. Never inspects
// UrlBlock.url, captions, or any other field — there is no pattern-
// matching against the uri's VALUE (e.g. checking for "file://") at all,
// only against the block's own `type` discriminator, so there is no way
// for this to mistake a legitimate link elsewhere in the payload for an
// image uri.
//
// BYTE-IDENTICAL WHEN NOTHING CHANGES: a note with no image blocks (the
// overwhelming majority) is returned as the SAME string reference,
// unchanged — this must never silently reformat/round-trip a note that
// had nothing to strip (e.g. turning a legacy plain-text note into
// block-JSON just by parsing and re-stringifying it would be an
// unrelated, unintended behavior change). Same contract as the client-
// side function, verified by test, not just asserted.
//
// This never REJECTS a payload — see api/share/index.js's own call site:
// it runs only after validateSharePayload/checkContent both already
// passed, as a final storage-time transform, never a new 400.

function sanitizeNote(note) {
  if (typeof note !== 'string' || !note.trimStart().startsWith('[')) return note; // empty, legacy plain text, or not present
  let parsed;
  try {
    parsed = JSON.parse(note);
  } catch {
    return note; // not valid JSON — treat as plain text, untouched
  }
  if (!Array.isArray(parsed)) return note;
  let changed = false;
  const sanitized = parsed.map((block) => {
    if (block && typeof block === 'object' && block.type === 'image' && block.uri) {
      changed = true;
      return { ...block, uri: '' };
    }
    return block;
  });
  if (!changed) return note; // nothing to strip — return the ORIGINAL string, byte-for-byte
  return JSON.stringify(sanitized);
}

/**
 * Recursively sanitizes `node` and every descendant in `node.children`.
 * Pure — never mutates `node` or any descendant; returns the SAME object
 * reference wherever nothing in that subtree changed.
 */
function sanitizeNode(node) {
  if (node == null || typeof node !== 'object') return node;
  const sanitizedNote = sanitizeNote(node.note);
  const children = Array.isArray(node.children) ? node.children.map(sanitizeNode) : node.children;
  const childrenChanged = Array.isArray(node.children) && Array.isArray(children)
    && children.some((c, i) => c !== node.children[i]);
  if (sanitizedNote === node.note && !childrenChanged) return node;
  return { ...node, note: sanitizedNote, children };
}

/**
 * Sanitizes a full Share Service payload — dispatches on `type` the same
 * way lib/shareSchema.js's validateSharePayload does (including the
 * legacy bare-Node shape, same structural check). qatlas_playlist/
 * qatlas_card/qatlas_cards payloads have no Node/note at all and are
 * returned untouched — there is nothing in those shapes an image block
 * could ever appear inside.
 *
 * Call this AFTER validateSharePayload/checkContent have both already
 * accepted the payload, immediately before createShare — see this
 * file's own header for why it never rejects anything itself.
 *
 * @param {unknown} payload
 * @returns {unknown} the same object reference if nothing needed
 *   stripping anywhere in the payload.
 */
function sanitizeSharePayload(payload) {
  if (payload == null || typeof payload !== 'object') return payload;

  if (payload.type === 'qatlas_topic' || payload.type === 'qatlas_topics') {
    const sanitizedNode = sanitizeNode(payload.node);
    if (sanitizedNode === payload.node) return payload;
    return { ...payload, node: sanitizedNode };
  }

  // Legacy bare-Node shape — same structural signature shareSchema.js's
  // isLegacyBareNodeShape checks for.
  if (typeof payload.id === 'string' && typeof payload.name === 'string'
    && Array.isArray(payload.children) && Array.isArray(payload.verses)) {
    return sanitizeNode(payload);
  }

  return payload; // qatlas_playlist / qatlas_card / qatlas_cards — nothing to sanitize
}

module.exports = { sanitizeSharePayload };
