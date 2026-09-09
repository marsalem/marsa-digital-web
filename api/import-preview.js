// api/import-preview.js
// Marsa Digital web — server-rendered version of quran-atlas/import.html
// (that static file is retired — see vercel.json's own rewrite of
// /quran-atlas/import to this function).
//
// Why this has to be server-rendered: messaging apps (iMessage, etc.)
// build a shared link's rich preview by fetching the URL and reading
// <title>/og:title BEFORE any JavaScript runs — a static HTML file can
// only ever offer one fixed title, no matter what's actually being
// shared. Per a direct "change the generic Shared content in the share
// message" request, this fetches the payload SERVER-SIDE (via
// lib/shareService.js's own getShare — no HTTP round-trip needed, same
// process) and renders a title reflecting the actual type: "Shared
// Playlist", "Shared Topic"/"Shared Topics", "Shared Reference
// Card"/"Shared Reference Cards".
//
// Also folds in the client-side page's own former fetch-by-id call:
// since this function already has the payload in hand to build the
// title, it embeds it directly into the response instead of making the
// browser fetch /api/share/:id a second time — same content, one fetch
// instead of two.
//
// LOGGING DISCIPLINE — same as the other api/share/* routes: never log
// payload contents, including in error paths.

const { getShare } = require('../lib/shareService');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function countVerses(node) {
  const verses = Array.isArray(node?.verses) ? node.verses.length : 0;
  const children = Array.isArray(node?.children) ? node.children : [];
  return verses + children.reduce((acc, c) => acc + countVerses(c), 0);
}

// Returns { pageTitle, subtitle, itemName, itemMeta } — pageTitle feeds
// <title>/og:title (must already be plain text, no markup); the rest
// feed the visible preview card and are HTML-escaped at render time,
// not here.
function describePayload(payload) {
  if (payload && payload.type === 'qatlas_playlist' && payload.playlist) {
    const playlist = payload.playlist;
    const count = (playlist.items || []).length;
    return {
      pageTitle: 'Shared Playlist',
      subtitle: 'Someone shared a Quran playlist with you',
      itemName: playlist.name || 'Shared Playlist',
      itemMeta: `${count} surah${count !== 1 ? 's' : ''}`,
    };
  }
  if (payload && payload.type === 'qatlas_card' && payload.card) {
    const card = payload.card;
    const verseCount = (card.verseRefs || []).length;
    const hadithCount = (card.hadithRefs || []).length;
    const parts = [];
    if (verseCount) parts.push(`${verseCount} verse${verseCount !== 1 ? 's' : ''}`);
    if (hadithCount) parts.push(`${hadithCount} hadith${hadithCount !== 1 ? '' : ''}`);
    return {
      pageTitle: 'Shared Reference Card',
      subtitle: 'Someone shared a reference card with you',
      itemName: card.title || 'Shared Reference Card',
      itemMeta: parts.join(' · ') || 'Reference card',
    };
  }
  if (payload && payload.type === 'qatlas_cards' && Array.isArray(payload.cards)) {
    const count = payload.cards.length;
    return {
      pageTitle: 'Shared Reference Cards',
      subtitle: 'Someone shared reference cards with you',
      itemName: 'Reference Cards',
      itemMeta: `${count} card${count !== 1 ? 's' : ''}`,
    };
  }
  if (payload && (payload.type === 'qatlas_topic' || payload.type === 'qatlas_topics') && payload.node) {
    const node = payload.node;
    const subCount = (node.children || []).length;
    const verseCount = countVerses(node);
    return {
      pageTitle: payload.type === 'qatlas_topics' ? 'Shared Topics' : 'Shared Topic',
      subtitle: 'Someone shared a Quran topic with you',
      itemName: node.name || 'Shared Topic',
      itemMeta: `${subCount} subtopic${subCount !== 1 ? 's' : ''} · ${verseCount} verse${verseCount !== 1 ? 's' : ''}`,
    };
  }
  // Legacy bare-Node shape (defensive only — see import-preview's own
  // header on why nothing the Share Service stores should ever be bare).
  if (payload && payload.id && payload.name && Array.isArray(payload.children) && Array.isArray(payload.verses)) {
    const subCount = payload.children.length;
    const verseCount = countVerses(payload);
    return {
      pageTitle: 'Shared Topic',
      subtitle: 'Someone shared a Quran topic with you',
      itemName: payload.name || 'Shared Topic',
      itemMeta: `${subCount} subtopic${subCount !== 1 ? 's' : ''} · ${verseCount} verse${verseCount !== 1 ? 's' : ''}`,
    };
  }
  return null;
}

function renderPage({ id, description }) {
  const pageTitle = description ? `${description.pageTitle} — Quran Atlas` : 'Quran Atlas — Shared Content';
  const ogTitle = description ? description.pageTitle : 'Quran Atlas';
  const ogDescription = description ? `${description.itemName} — ${description.itemMeta}` : 'Someone shared something with you';
  // Gated on `description` too, not just `id` — an id that failed to
  // resolve (expired/invalid/deleted share) must NOT offer "Open in
  // Quran Atlas" or auto-redirect; that would just reopen the exact
  // "app opens to nothing useful" problem this whole Share Service
  // exists to fix, just moved one step earlier.
  const deepLink = (id && description) ? `quranatlas://import?id=${encodeURIComponent(id)}` : null;

  const itemBoxHtml = description ? `
    <div class="item-box" style="display:block">
      <div class="item-name">${escapeHtml(description.itemName)}</div>
      <div class="item-meta">${escapeHtml(description.itemMeta)}</div>
    </div>` : '';

  const buttonsHtml = deepLink ? `
    <a class="btn" href="${escapeHtml(deepLink)}">Open in Quran Atlas</a>
    <a class="btn" href="https://apps.apple.com/app/id6781110875">Download Quran Atlas</a>` : '';

  const errorHtml = !description ? `
    <p class="error" style="display:block">Could not read the shared content. The link may be invalid or expired.</p>
    <a class="btn" href="https://apps.apple.com/app/id6781110875" style="display:block">Download Quran Atlas</a>` : '';

  // Auto-redirect into the app — same behavior the old client-side page
  // had, just triggered on load rather than after its own fetch resolves
  // (the fetch already happened server-side, above).
  const redirectScript = deepLink ? `<script>window.location.href = ${JSON.stringify(deepLink)};</script>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${escapeHtml(pageTitle)}</title>
  <meta property="og:title" content="${escapeHtml(ogTitle)}"/>
  <meta property="og:description" content="${escapeHtml(ogDescription)}"/>
  <meta property="og:type" content="website"/>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #EAF1F8; color: #10243D; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; }
    .card { background: white; border-radius: 24px; padding: 40px 32px; max-width: 480px; width: 100%; box-shadow: 0 8px 40px rgba(0,0,0,0.1); text-align: center; }
    .icon { font-size: 3rem; margin-bottom: 16px; }
    h1 { font-size: 1.6rem; font-weight: 800; margin-bottom: 8px; color: #10243D; }
    .subtitle { font-size: 1rem; color: #5A6A7A; margin-bottom: 24px; }
    .item-box { background: #EAF1F8; border-radius: 16px; padding: 20px; margin-bottom: 24px; border-left: 4px solid #326499; text-align: left; }
    .item-name { font-size: 1.2rem; font-weight: 700; color: #326499; margin-bottom: 4px; }
    .item-meta { font-size: 0.9rem; color: #7E97AF; }
    .btn { display: block; background: #326499; color: white; padding: 16px; border-radius: 14px; text-decoration: none; font-weight: 700; font-size: 1rem; margin-bottom: 12px; }
    .btn:hover { background: #2a5580; }
    .btn-secondary { display: block; background: #EAF1F8; color: #326499; padding: 14px; border-radius: 14px; text-decoration: none; font-weight: 600; font-size: 0.95rem; }
    .error { color: #E07B4F; font-size: 0.95rem; margin-top: 16px; margin-bottom: 16px; }
    footer { margin-top: 32px; color: #8FA8BD; font-size: 0.8rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🌙</div>
    <h1>Quran Atlas</h1>
    <p class="subtitle">${escapeHtml(description ? description.subtitle : 'Someone shared something with you')}</p>
    ${itemBoxHtml}
    ${buttonsHtml}
    ${errorHtml}
    <a class="btn-secondary" href="/quran-atlas">Learn More About Quran Atlas</a>
  </div>
  <footer>© 2026 Marsa Digital</footer>
  ${redirectScript}
</body>
</html>`;
}

module.exports = async function handler(req, res) {
  const id = typeof req.query.id === 'string' ? req.query.id : undefined;

  let description = null;
  if (id) {
    try {
      const payload = await getShare(id);
      description = describePayload(payload);
    } catch (err) {
      console.error('import-preview getShare failed:', err instanceof Error ? err.message : String(err));
    }
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(renderPage({ id, description }));
};
