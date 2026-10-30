// quran-atlas/admin-preview.js
// Marsa Digital web — pure, DOM-free parsing/normalization for the admin
// moderation dashboard's "View reported content" preview
// (quran-atlas/admin.html). No fetch, no DOM, no Redis — takes the exact
// JSON payload GET /api/share/:id already returns and turns it into a
// plain, render-ready structure. Kept separate from admin.html's own
// inline script SPECIFICALLY so this logic is unit-testable offline via
// `node --test` — admin.html's existing script has zero test coverage
// today (everything in it is DOM-bound); this file exists so the new
// preview feature doesn't inherit that same gap.
//
// Works as both a browser <script> (exposes window.AdminPreview) and a
// CommonJS module (for node --test) via a minimal UMD-style guard — the
// smallest correct way to get both environments from one file with zero
// build step and zero new dependency, matching this whole page's own
// no-bundler convention.
//
// BOUNDS — mirror lib/shareConstants.js's write-time limits
// (MAX_NODE_DEPTH/MAX_ARRAY_LENGTH/MAX_TOTAL_NODES), duplicated here
// deliberately (same convention app/utils/sharing.ts's own REPORT_REASONS
// comment already uses) rather than imported — a plain browser <script>
// tag has no module resolution to reach across the repo boundary anyway.
// These are a DEFENSE-IN-DEPTH cap on what THIS code will ever walk,
// independent of server-side validation: anything written after
// lib/shareSchema.js existed is already well inside these limits; a
// legacy pre-schema share has no such guarantee, and this is what stops
// a pathological one from locking up the browser tab while rendering.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AdminPreview = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_NODE_DEPTH = 25;
  var MAX_ARRAY_LENGTH = 1000;
  var MAX_TOTAL_NODES = 5000;

  // ── Block parsing — port of app/utils/blocks.ts's getNodeBlocks() ──
  // Same contract: never throws, degrades to [] or a single synthetic
  // text block rather than losing the caller's own request entirely.
  function isBlockArray(x) {
    return Array.isArray(x) && x.every(function (b) {
      return !!b && typeof b === 'object' && typeof b.id === 'string' && typeof b.type === 'string';
    });
  }

  function migrateNoteToTextBlock(note) {
    if (!note || !String(note).trim()) return [];
    return [{ id: '__migrated__', type: 'text', text: String(note) }];
  }

  function parseNoteBlocks(note) {
    var raw = note;
    if (!raw) return [];
    if (typeof raw !== 'string') {
      if (raw && typeof raw === 'object' && typeof raw.note === 'string') {
        return parseNoteBlocks(raw.note);
      }
      return [];
    }
    if (raw.trimStart().startsWith('[')) {
      try {
        var parsed = JSON.parse(raw);
        if (isBlockArray(parsed)) return parsed;
      } catch (e) { /* not block JSON — fall through to legacy plain-text handling */ }
    }
    return migrateNoteToTextBlock(raw);
  }

  var KNOWN_BLOCK_TYPES = {
    heading: true, text: true, ayah: true, hadith: true, table: true,
    url: true, image: true, mention: true, bulletList: true,
    numberedList: true, toggle: true,
  };
  function isKnownBlockType(type) {
    return !!KNOWN_BLOCK_TYPES[type];
  }

  // Only http(s) is ever treated as a real, clickable link — same scheme
  // allowlist convention as lib/contentFilter.js's own scanUrl
  // (ALLOWED_URL_SCHEMES). The write-time content filter already blocks
  // dangerous schemes for anything shared after it existed; this is a
  // defensive re-check for legacy/pre-filter stored content, so the
  // renderer never turns an unexpected scheme into a real navigable link.
  function isSafeHttpUrl(url) {
    if (typeof url !== 'string') return false;
    return url.indexOf('http://') === 0 || url.indexOf('https://') === 0;
  }

  // ── Bounded Node-tree walk ──
  function walkNode(node, depth, counters) {
    if (!node || typeof node !== 'object') return null;
    if (depth > MAX_NODE_DEPTH) { counters.truncated = true; return null; }
    counters.total += 1;
    if (counters.total > MAX_TOTAL_NODES) { counters.truncated = true; return null; }

    var verses = Array.isArray(node.verses) ? node.verses.slice(0, MAX_ARRAY_LENGTH) : [];
    if (Array.isArray(node.verses) && node.verses.length > MAX_ARRAY_LENGTH) counters.truncated = true;
    var hadiths = Array.isArray(node.hadiths) ? node.hadiths.slice(0, MAX_ARRAY_LENGTH) : [];
    if (Array.isArray(node.hadiths) && node.hadiths.length > MAX_ARRAY_LENGTH) counters.truncated = true;

    var blocks = parseNoteBlocks(node.note);
    if (blocks.length > MAX_ARRAY_LENGTH) { blocks = blocks.slice(0, MAX_ARRAY_LENGTH); counters.truncated = true; }

    var rawChildren = Array.isArray(node.children) ? node.children : [];
    var cappedChildren = rawChildren.slice(0, MAX_ARRAY_LENGTH);
    if (rawChildren.length > MAX_ARRAY_LENGTH) counters.truncated = true;
    var children = [];
    for (var i = 0; i < cappedChildren.length; i++) {
      var child = walkNode(cappedChildren[i], depth + 1, counters);
      if (child) children.push(child);
    }

    return {
      name: typeof node.name === 'string' ? node.name : '',
      verses: verses,
      hadiths: hadiths,
      blocks: blocks,
      children: children,
    };
  }

  function parseTopicNode(node) {
    var counters = { total: 0, truncated: false };
    var tree = walkNode(node, 0, counters);
    return { tree: tree, truncated: counters.truncated };
  }

  // ── Payload-shape dispatch ──
  // Mirrors app/utils/sharing.ts's parseTopicSharePayload/
  // parseCardSharePayload/parseCardsBundleSharePayload/
  // parsePlaylistSharePayload + lib/shareSchema.js's
  // isLegacyBareNodeShape, READ-SIDE only — this never validates/rejects
  // the way write-time shareSchema.js does, it only needs to recognize a
  // shape well enough to render it, same "tolerate what's already
  // stored" posture parseNoteBlocks itself takes above.
  function isLegacyBareNodeShape(payload) {
    return !!payload && typeof payload === 'object'
      && typeof payload.id === 'string' && typeof payload.name === 'string'
      && Array.isArray(payload.children) && Array.isArray(payload.verses);
  }

  function parseSharePayload(payload) {
    if (payload == null || typeof payload !== 'object') {
      return { kind: 'unknown' };
    }
    if (payload.type === 'qatlas_topic' || payload.type === 'qatlas_topics') {
      return { kind: 'topic', isBundle: payload.type === 'qatlas_topics', result: parseTopicNode(payload.node) };
    }
    if (payload.type === 'qatlas_card' && payload.card) {
      return { kind: 'card', cards: [payload.card] };
    }
    if (payload.type === 'qatlas_cards' && Array.isArray(payload.cards)) {
      var cards = payload.cards.slice(0, MAX_ARRAY_LENGTH);
      return { kind: 'card', cards: cards, truncated: payload.cards.length > MAX_ARRAY_LENGTH };
    }
    if (payload.type === 'qatlas_playlist' && payload.playlist) {
      var playlist = payload.playlist;
      var rawItems = Array.isArray(playlist.items) ? playlist.items : [];
      var items = rawItems.slice(0, MAX_ARRAY_LENGTH);
      return {
        kind: 'playlist',
        name: typeof playlist.name === 'string' ? playlist.name : '',
        items: items,
        truncated: rawItems.length > MAX_ARRAY_LENGTH,
      };
    }
    if (isLegacyBareNodeShape(payload)) {
      return { kind: 'topic', isBundle: false, result: parseTopicNode(payload) };
    }
    return { kind: 'unknown' };
  }

  // ── Label formatting ──
  // A Topic's own Node.verses/Node.hadiths (models.ts Verse/HadithNodeRef)
  // already carry a precomputed `label` string — prefer it. A Reference
  // Card's verseRefs/hadithRefs, and a Playlist's items, carry ONLY bare
  // numbers (confirmed: no `label` field exists on those types at all) —
  // fall back to constructing a plain numeric reference from surah/ayah.
  function formatVerseRefLabel(v) {
    if (!v || typeof v !== 'object') return '';
    if (typeof v.label === 'string' && v.label) return v.label;
    var ref = 'Surah ' + v.surah;
    if (v.ayah !== undefined && v.ayah !== null) {
      ref += ':' + v.ayah;
      if (v.ayahEnd !== undefined && v.ayahEnd !== null && v.ayahEnd !== v.ayah) ref += '-' + v.ayahEnd;
    }
    return ref;
  }

  function formatHadithRefLabel(h) {
    if (!h || typeof h !== 'object') return '';
    if (typeof h.label === 'string' && h.label) return h.label;
    return String(h.bookId) + ' #' + h.hadithId;
  }

  // Playlist items use ayahStart/ayahEnd (not ayah/ayahEnd like
  // Verse/verseRefs) — confirmed distinct shape (models.ts PlaylistItem)
  // and have no label field at all, same as Reference Card verseRefs.
  function formatPlaylistItemLabel(item) {
    if (!item || typeof item !== 'object') return '';
    var label = 'Surah ' + item.surah;
    if (item.ayahStart === undefined || item.ayahStart === null) {
      label += ' (whole surah)';
    } else if (item.ayahEnd === undefined || item.ayahEnd === null || item.ayahEnd === item.ayahStart) {
      label += ':' + item.ayahStart;
    } else {
      label += ':' + item.ayahStart + '-' + item.ayahEnd;
    }
    if (item.repeatCount && item.repeatCount > 1) label += ' (×' + item.repeatCount + ')';
    return label;
  }

  return {
    parseNoteBlocks: parseNoteBlocks,
    isKnownBlockType: isKnownBlockType,
    isSafeHttpUrl: isSafeHttpUrl,
    parseTopicNode: parseTopicNode,
    parseSharePayload: parseSharePayload,
    formatVerseRefLabel: formatVerseRefLabel,
    formatHadithRefLabel: formatHadithRefLabel,
    formatPlaylistItemLabel: formatPlaylistItemLabel,
    MAX_NODE_DEPTH: MAX_NODE_DEPTH,
    MAX_ARRAY_LENGTH: MAX_ARRAY_LENGTH,
    MAX_TOTAL_NODES: MAX_TOTAL_NODES,
  };
});
