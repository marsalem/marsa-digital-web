// api/import-preview.js
// Marsa Digital web — server-rendered universal shared-content landing page.
//
// Why this has to be server-rendered: messaging apps (iMessage, etc.) build a
// shared link's rich preview by fetching the URL and reading <title>/og:title
// BEFORE any JavaScript runs — a static HTML file can only ever offer one
// fixed title, no matter what's actually being shared. This fetches the
// payload SERVER-SIDE (via lib/shareService.js's own getShare — no HTTP
// round-trip needed, same process) and renders a title/description reflecting
// the actual type: playlist, single/bundle reference card, single/bundle
// topic, or a legacy bare-Node topic export.
//
// The page is bilingual (EN/AR) and theme-aware (light/dark), using the exact
// same assets/css/base.css tokens and qa-theme/qa-lang toggle infrastructure
// as every other Quran Atlas web page — see
// docs/marsa-digital-web-redesign-copy-and-plan.md for the full design trail.
//
// Preview content is deliberately shallow: name + counts + (for bundles) up
// to 3 item names — never full verse/hadith text, notes, or voice memos. The
// Share Service's own resolution/getShare logic and the app's deep-link
// gating behavior (no "Open in Quran Atlas" button unless the payload
// actually resolved) are unchanged.
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

// English plural — unchanged simple pattern already used throughout the app's
// own web copy.
function enCount(n, singular, plural) {
  return `${n} ${n === 1 ? singular : (plural || singular + 's')}`;
}

// Arabic noun-count agreement genuinely changes the noun's own shape by count
// (singular / dual / 3-10 plural / 11+ singular-accusative) — not just a
// digit swap, so a single template string can't cover it correctly. `forms`
// is [singular, dual, plural3to10, plural11plus].
function arCount(n, forms) {
  const [one, two, few, many] = forms;
  if (n === 1) return one;
  if (n === 2) return two;
  if (n >= 3 && n <= 10) return `${n} ${few}`;
  return `${n} ${many}`;
}
const AR_VERSE = ['آية واحدة', 'آيتان', 'آيات', 'آية'];
const AR_HADITH = ['حديث واحد', 'حديثان', 'أحاديث', 'حديثًا'];
const AR_CARD = ['بطاقة واحدة', 'بطاقتان', 'بطاقات', 'بطاقة'];
const AR_TOPIC = ['موضوع واحد', 'موضوعان', 'مواضيع', 'موضوعًا'];
const AR_SUBTOPIC = ['موضوع فرعي واحد', 'موضوعان فرعيان', 'مواضيع فرعية', 'موضوعًا فرعيًا'];
const AR_ITEM = ['عنصر واحد', 'عنصران', 'عناصر', 'عنصرًا'];

// Up to 3 names from a bundle, plus a "+N more" remainder count.
function previewNames(names, max = 3) {
  const clean = names.filter(Boolean);
  return { shown: clean.slice(0, max), more: Math.max(0, clean.length - max) };
}

// Returns a fully bilingual description of the payload, or null if the
// payload's shape doesn't match any known type (malformed/unsupported).
// - pageTitle/ogTitle/ogDescription: English only — crawlers never run the
//   language-toggle JS, and there's no reliable server-side signal for a
//   bot's preferred language, so these stay fixed (matches prior behavior).
// - Everything else is { en, ar } for the human-facing card.
function describePayload(payload) {
  if (payload && payload.type === 'qatlas_playlist' && payload.playlist) {
    const playlist = payload.playlist;
    const count = (playlist.items || []).length;
    const name = playlist.name || 'Shared Playlist';
    return {
      pageTitle: 'Shared Playlist',
      ogDescription: `${name} — ${enCount(count, 'item')}`,
      icon: 'musical-notes-outline',
      heading: { en: 'Someone shared a playlist with you', ar: 'شارك معك أحدهم قائمة تشغيل' },
      itemName: name,
      itemMeta: { en: enCount(count, 'item'), ar: arCount(count, AR_ITEM) },
      names: null,
    };
  }
  if (payload && payload.type === 'qatlas_card' && payload.card) {
    const card = payload.card;
    const verseCount = (card.verseRefs || []).length;
    const hadithCount = (card.hadithRefs || []).length;
    const enParts = [];
    const arParts = [];
    if (verseCount) { enParts.push(enCount(verseCount, 'verse')); arParts.push(arCount(verseCount, AR_VERSE)); }
    if (hadithCount) { enParts.push(enCount(hadithCount, 'hadith', 'hadith')); arParts.push(arCount(hadithCount, AR_HADITH)); }
    const name = card.title || 'Shared Reference Card';
    return {
      pageTitle: 'Shared Reference Card',
      ogDescription: `${name} — ${enParts.join(' · ') || 'Reference card'}`,
      icon: 'id-card-outline',
      heading: { en: 'Someone shared a reference card with you', ar: 'شارك معك أحدهم بطاقة مرجعية' },
      itemName: name,
      itemMeta: { en: enParts.join(' · ') || 'Reference card', ar: arParts.join(' · ') || 'بطاقة مرجعية' },
      names: null,
    };
  }
  if (payload && payload.type === 'qatlas_cards' && Array.isArray(payload.cards)) {
    const count = payload.cards.length;
    const { shown, more } = previewNames(payload.cards.map(c => c.title));
    return {
      pageTitle: 'Shared Reference Cards',
      ogDescription: enCount(count, 'reference card'),
      icon: 'albums-outline',
      heading: { en: 'Someone shared reference cards with you', ar: 'شارك معك أحدهم بطاقات مرجعية' },
      itemName: null,
      itemMeta: { en: enCount(count, 'card'), ar: arCount(count, AR_CARD) },
      names: { shown, more },
    };
  }
  if (payload && payload.type === 'qatlas_topics' && payload.node) {
    // Bundle wrapper Node (id starts with "bundle_") — its own `children` are
    // the actual shared topics; see buildTopicsBundleShareLink's call site in
    // app/index.tsx for why this shape is a synthetic wrapper, not a real topic.
    const node = payload.node;
    const children = Array.isArray(node.children) ? node.children : [];
    const { shown, more } = previewNames(children.map(c => c.name));
    return {
      pageTitle: 'Shared Topics',
      ogDescription: enCount(children.length, 'topic'),
      icon: 'library-outline',
      heading: { en: 'Someone shared topics with you', ar: 'شارك معك أحدهم مواضيع' },
      itemName: null,
      itemMeta: { en: enCount(children.length, 'topic'), ar: arCount(children.length, AR_TOPIC) },
      names: { shown, more },
    };
  }
  if (payload && payload.type === 'qatlas_topic' && payload.node) {
    const node = payload.node;
    const subCount = (node.children || []).length;
    const verseCount = countVerses(node);
    const name = node.name || 'Shared Topic';
    return {
      pageTitle: 'Shared Topic',
      ogDescription: `${name} — ${enCount(subCount, 'subtopic')} · ${enCount(verseCount, 'verse')}`,
      icon: 'library-outline',
      heading: { en: 'Someone shared a topic with you', ar: 'شارك معك أحدهم موضوعًا' },
      itemName: name,
      itemMeta: {
        en: `${enCount(subCount, 'subtopic')} · ${enCount(verseCount, 'verse')}`,
        ar: `${arCount(subCount, AR_SUBTOPIC)} · ${arCount(verseCount, AR_VERSE)}`,
      },
      names: null,
    };
  }
  // Legacy bare-Node shape — old single-topic exports/deep-links that predate
  // the `type` field entirely (see parseTopicSharePayload's own structural
  // fallback in app/utils/sharing.ts). Always a single topic, never a bundle.
  if (payload && payload.id && payload.name && Array.isArray(payload.children) && Array.isArray(payload.verses)) {
    const subCount = payload.children.length;
    const verseCount = countVerses(payload);
    const name = payload.name || 'Shared Topic';
    return {
      pageTitle: 'Shared Topic',
      ogDescription: `${name} — ${enCount(subCount, 'subtopic')} · ${enCount(verseCount, 'verse')}`,
      icon: 'library-outline',
      heading: { en: 'Someone shared a topic with you', ar: 'شارك معك أحدهم موضوعًا' },
      itemName: name,
      itemMeta: {
        en: `${enCount(subCount, 'subtopic')} · ${enCount(verseCount, 'verse')}`,
        ar: `${arCount(subCount, AR_SUBTOPIC)} · ${arCount(verseCount, AR_VERSE)}`,
      },
      names: null,
    };
  }
  return null;
}

// Ionicons glyphs, extracted directly from the app's own bundled Ionicons.ttf
// (fontTools SVGPathPen against the same glyph-name → codepoint map the app's
// <Ionicons name="..."/> calls use) — pixel-exact, not redrawn. Font is
// y-up, so each glyph is wrapped in the same translate/scale flip the app's
// icons need throughout the landing page.
function iconSvg(name, size) {
  const d = ICON_PATHS[name];
  if (!d) return '';
  return `<svg viewBox="0 0 512 512" width="${size}" height="${size}"><g transform="translate(0,512) scale(1,-1)"><path d="${d}" fill="currentColor"/></g></svg>`;
}

const ICON_PATHS = {
  'musical-notes-outline': 'M407 415Q417 416 425 407Q426 406 427 405Q431 402 431.5 385.0Q432 368 432 269Q432 244 432 230Q432 65 431 61Q425 41 409 32Q397 25 373 18Q360 14 346 18Q332 21 321 32Q304 49 304 73Q304 81 306 87Q314 110 338 119Q345 122 367.5 130.0Q390 138 392 139Q397 142 399 148Q400 151 400.0 222.5Q400 294 399.0 296.0Q398 298 396 298Q394 298 306.0 274.0Q218 250 216 249Q212 247 210.5 244.0Q209 241 208.5 128.5Q208 16 206 12Q199 -12 175 -21Q140 -35 122.0 -30.5Q104 -26 92.0 -10.5Q80 5 80 24Q80 36 85 47Q91 58 101 65Q108 69 142 81Q163 89 168.0 91.5Q173 94 175 98Q176 101 176 217Q176 309 176.5 324.0Q177 339 180 345Q184 354 193 359Q198 361 296.5 387.5Q395 414 398.0 414.5Q401 415 407 415ZM400 356Q400 363 400.0 369.0Q400 375 400.0 378.5Q400 382 400.0 382.0Q400 382 304 356L209 331L208 306L210 281Q214 283 301.5 306.0Q389 329 393 330L400 331ZM399 107Q396 106 370.5 96.5Q345 87 343 86Q336 81 336 70Q337 62 343 55Q349 48 358 48Q364 48 378 53Q397 60 399 68Q400 71 400.0 89.0Q400 107 399 107ZM176 39Q176 44 176.0 48.5Q176 53 175.5 56.0Q175 59 175 59Q175 59 147.5 49.5Q120 40 117 37Q111 31 112.5 20.5Q114 10 122 5Q132 -3 154 5Q170 11 173 15Q173 15 175 18Z',
  'id-card-outline': 'M132 431Q136 432 259 431H381L388 429Q402 424 413.0 413.0Q424 402 429 388L431 381V192V3L429 -4Q424 -18 413.0 -29.0Q402 -40 388 -45L381 -47H256H131L124 -45Q110 -40 99.0 -29.0Q88 -18 83 -4L81 3V192V381L83 388Q89 404 102.5 416.0Q116 428 132 431ZM381 397 375 400H259Q143 400 139 399Q123 397 115 381L112 375V192V9L115 3Q122 -12 138 -15Q143 -16 256.0 -16.0Q369 -16 374 -15Q390 -12 397 3L400 9V192V375L397 381Q392 392 381 397ZM204 383Q205 384 257 384H310L313 381Q319 376 320 370Q321 356 307 353Q303 352 256.0 352.0Q209 352 205 353Q193 355 192.5 367.0Q192 379 204 383ZM293 174Q311 179 327 169Q343 159 344.0 138.0Q345 117 330 102Q312 84 290 93Q277 99 269.5 113.0Q262 127 265 142Q268 168 293 174ZM286 70Q286 70 286 70Q303 73 320 70Q359 64 376 36Q385 21 384 11Q383 4 377 1Q374 0 304.0 0.0Q234 0 231 1Q222 6 225 18Q230 38 246.5 52.0Q263 66 286 70Z',
  'albums-outline': 'M140 383Q141 384 257 384H374L377 381Q383 376 384 370Q385 356 371 353Q367 352 256.0 352.0Q145 352 141 353Q129 355 128.5 367.0Q128 379 140 383ZM108 336Q111 336 257 336H404L408 334Q416 329 416.0 320.0Q416 311 408 306L405 304H256H107L104 306Q91 314 98 328Q101 334 108 336ZM80 286Q85 287 255.5 287.5Q426 288 431 286Q443 283 452.0 273.0Q461 263 463 251Q464 246 464 144Q464 60 463.5 46.0Q463 32 459 25Q453 11 439 4Q433 2 429 1Q424 0 256.0 0.0Q88 0 83 1Q79 2 73 4Q59 11 53 25Q49 32 48.5 46.0Q48 60 48 144Q48 246 49 251Q51 263 60.0 273.0Q69 283 80 286ZM425 254Q425 254 425 254Q422 256 256.0 256.0Q90 256 87.0 254.5Q84 253 82.5 250.5Q81 248 80 145Q80 145 80 41L82 38Q84 36 86 34Q86 34 89 32H256H423L426 34Q428 36 430 38Q430 38 432 41V145Q431 248 429.5 250.5Q428 253 425 254Z',
  'library-outline': 'M260 414 265 416 305 415H345L349 413Q360 408 365 398L367 392L368 376L369 361Q374 363 397.5 365.5Q421 368 428 368Q439 367 449 358Q457 350 460 340Q461 337 478.5 175.0Q496 13 496 6Q495 -8 484 -18Q478 -24 470.5 -26.0Q463 -28 439 -30Q413 -33 404 -28Q388 -20 384 -3Q383 1 376.0 67.5Q369 134 368 136Q368 137 368.0 127.5Q368 118 368.0 101.5Q368 85 368 66Q368 -6 366 -11Q360 -26 346 -31Q341 -32 303.5 -32.0Q266 -32 261.0 -30.0Q256 -28 252 -25L248 -22L244 -25Q240 -28 235.0 -30.0Q230 -32 180.5 -32.5Q131 -33 125 -32Q113 -30 107 -24L104 -21L101 -24Q94 -30 84 -32Q79 -32 64.0 -32.0Q49 -32 44 -32Q26 -29 19 -13L17 -8V168V344L19 349Q24 360 35 365L40 367H64H88L93 365Q104 360 109 349Q111 344 112 322V300L116 302Q120 303 176.5 303.0Q233 303 236 302L240 300V343Q240 386 241 390Q244 407 260 414ZM336 192V384H304H272V192V0H304H336ZM80 168V336H64H48V168V0H64H80ZM425 336Q383 332 381 330Q380 330 380 326Q381 323 398.0 165.5Q415 8 415 4Q416 2 418.0 1.0Q420 0 440.5 2.0Q461 4 462.5 5.5Q464 7 463.5 10.5Q463 14 446.0 172.0Q429 330 428.5 332.0Q428 334 427.0 335.0Q426 336 425 336ZM224 256V272H176H128V256V240H176H224ZM224 136V208H176H128V136V64H176H224ZM224 16V32H176H128V16V0H176H224Z',
  'time-outline': 'M241 399Q256 400 269 399Q351 394 407 335Q452 287 462 220Q464 210 464.0 192.0Q464 174 462 164Q454 109 421 66Q405 43 382 27Q339 -6 284 -14Q274 -16 256.0 -16.0Q238 -16 228 -14Q173 -6 130 27Q107 43 91 66Q58 109 50 164Q48 174 48.0 192.0Q48 210 50 220Q58 274 91 318Q107 340 130 357Q181 395 241 399ZM284 366Q278 367 261.5 367.5Q245 368 240 367Q212 364 193 356Q149 339 119.5 303.0Q90 267 82 219Q81 210 81.0 192.0Q81 174 82 165Q89 122 114.0 88.0Q139 54 178 34Q214 16 256.0 16.0Q298 16 334 34Q372 54 397.0 87.5Q422 121 430 164Q431 173 431.0 191.5Q431 210 430 219Q420 279 378 319Q338 356 284 366ZM252 335Q252 335 252 335Q258 337 263.5 334.0Q269 331 271 324Q272 321 272 257Q272 257 272 192H314Q355 192 359 190Q372 184 367 170Q364 162 355 160Q350 160 301 160Q301 160 252 160L248 162Q244 165 242 168Q242 168 240 171V246Q240 321 241 324Q243 333 252 335Z',
  'help-circle-outline': 'M242 383Q261 385 284 382Q313 377 340 364Q395 338 424.5 284.5Q454 231 447 170Q441 121 413.0 81.0Q385 41 340 20Q285 -8 224.5 2.5Q164 13 120 57Q98 79 84 107Q64 147 64.0 192.0Q64 237 84 277Q113 336 172 364Q203 379 242 383ZM279 350Q272 351 257.0 351.5Q242 352 235 351Q181 343 143 305Q105 267 98 215Q94 192 98 169Q107 107 156.0 67.5Q205 28 267 32Q320 36 359.5 70.0Q399 104 412 155Q419 184 414 215Q407 267 369.0 305.0Q331 343 279 350ZM243 303Q248 304 261.0 303.5Q274 303 279 302Q300 296 314 279Q327 263 326 241Q325 224 316.5 211.5Q308 199 287 184Q267 170 265 155Q264 143 257 140Q246 134 239 145Q232 156 243 178Q251 193 271 208Q290 221 295 230Q297 236 297.0 244.0Q297 252 295 256Q288 270 272 274Q267 275 258.5 275.5Q250 276 245 275Q225 271 217 253Q214 248 214 246Q214 239 208 234Q200 228 191 235Q184 242 188 256Q193 274 208.5 287.0Q224 300 243 303ZM241 118Q241 118 241 118Q251 123 261 117Q269 111 270 102Q270 93 265 87Q259 80 250 80Q242 80 237 86Q229 93 230.5 103.0Q232 113 241 118Z',
};

const APPLE_ICON = '<svg viewBox="53 96 395 449" width="16" height="18"><g transform="translate(0,512) scale(1,-1)"><path d="M326 413Q334 415 337 416H340L341 410Q343 389 332.0 365.0Q321 341 300.0 325.5Q279 310 256 308H249V312Q248 321 250 332Q255 361 276.0 383.5Q297 406 326 413ZM161 309Q161 309 161 309Q168 311 181 310Q198 310 226 300Q251 292 263.5 292.0Q276 292 299 300Q313 305 322.0 307.5Q331 310 348.0 310.0Q365 310 371 308Q393 302 412 288Q416 285 425.0 276.0Q434 267 434 266Q434 266 427 261Q390 236 385 191Q382 162 395 135Q410 104 441 90Q441 90 448 87L445 80Q432 52 413 24Q377 -28 346 -31Q330 -33 307 -23Q281 -11 255 -14Q240 -15 220 -23Q200 -32 188 -32Q155 -32 122 12Q85 61 71 118Q53 194 79 245Q91 269 114.0 287.0Q137 305 161 309Z" fill="currentColor"/></g></svg>';
const PLAY_ICON = '<svg viewBox="48 96 416 448" width="17" height="18"><g transform="translate(0,512) scale(1,-1)"><path d="M87 416Q88 416 215.5 346.0Q343 276 344 274Q345 274 343.5 272.5Q342 271 338.5 267.5Q335 264 329.5 258.5Q324 253 315 245L285 216L184 313Q83 410 83.0 412.0Q83 414 84.0 415.0Q85 416 87 416ZM48.0 192.0Q48 390 49.0 391.5Q50 393 52.0 393.0Q54 393 156.5 293.0Q259 193 259.0 192.0Q259 191 156.5 91.0Q54 -9 52.0 -9.0Q50 -9 49.0 -7.5Q48 -6 48.0 192.0ZM456 212Q464 204 464.0 192.0Q464 180 456 172Q451 168 415.0 148.0Q379 128 378 128Q378 128 344.5 159.5Q311 191 311 192Q311 193 344.0 224.5Q377 256 378.5 255.5Q380 255 415.5 235.5Q451 216 456 212ZM184 71Q184 71 184 71L285 168L315 139Q345 111 345 110Q346 108 95 -28Q87 -32 85.0 -31.0Q83 -30 83 -28Q83 -26 100.0 -9.5Q117 7 184 71Z" fill="currentColor"/></g></svg>';

function bilingual(en, ar) {
  return `<span data-en>${escapeHtml(en)}</span><span data-ar>${escapeHtml(ar)}</span>`;
}

function renderPage({ id, resolutionState, description }) {
  // resolutionState: 'ok' | 'not_found' | 'malformed'
  const pageTitle = description ? `${description.pageTitle} — Quran Atlas` : 'Quran Atlas — Shared Content';
  const ogTitle = description ? description.pageTitle : 'Quran Atlas';
  const ogDescription = description ? description.ogDescription : 'Someone shared something with you';
  // Gated on resolutionState === 'ok', not just `id` — an id that failed to
  // resolve (expired/invalid/malformed) must NOT offer "Open in Quran Atlas"
  // or auto-redirect; that would just reopen the exact "app opens to nothing
  // useful" problem this whole Share Service exists to fix, just moved one
  // step earlier.
  const deepLink = (id && resolutionState === 'ok') ? `quranatlas://import?id=${encodeURIComponent(id)}` : null;

  let bodyHtml;
  if (resolutionState === 'ok' && description) {
    const iconHtml = iconSvg(description.icon, 34);
    const nameLine = description.itemName ? `<div class="item-name">${escapeHtml(description.itemName)}</div>` : '';
    const metaLine = `<div class="item-meta">${bilingual(description.itemMeta.en, description.itemMeta.ar)}</div>`;
    let namesHtml = '';
    if (description.names && description.names.shown.length) {
      const rows = description.names.shown.map(n => `<div class="name-row">${escapeHtml(n)}</div>`).join('');
      const more = description.names.more > 0
        ? `<div class="name-more">${bilingual(`+${description.names.more} more`, `+${description.names.more} أخرى`)}</div>`
        : '';
      namesHtml = `<div class="name-list">${rows}${more}</div>`;
    }
    bodyHtml = `
      <div class="preview-icon">${iconHtml}</div>
      <p class="subtitle">${bilingual(description.heading.en, description.heading.ar)}</p>
      <div class="item-box">
        ${nameLine}
        ${metaLine}
        ${namesHtml}
      </div>
      <div class="store-buttons">
        <a class="cta primary" href="${escapeHtml(deepLink)}">${bilingual('Open in Quran Atlas', 'افتح في أطلس القرآن')}</a>
        <a class="cta secondary-store" href="https://apps.apple.com/app/id6781110875">${APPLE_ICON}${bilingual('Download Quran Atlas', 'تحميل أطلس القرآن')}</a>
      </div>`;
  } else {
    const errorCopy = resolutionState === 'not_found'
      ? bilingual('This link has expired or no longer exists.', 'انتهت صلاحية هذا الرابط أو لم يعد موجودًا.')
      : bilingual("This content can't be opened here — open it directly in Quran Atlas.", 'لا يمكن فتح هذا المحتوى هنا — افتحه مباشرة داخل تطبيق أطلس القرآن.');
    const iconHtml = iconSvg(resolutionState === 'not_found' ? 'time-outline' : 'help-circle-outline', 34);
    bodyHtml = `
      <div class="preview-icon error-icon">${iconHtml}</div>
      <p class="error-text">${errorCopy}</p>
      <div class="store-buttons">
        <a class="cta primary" href="https://apps.apple.com/app/id6781110875">${APPLE_ICON}${bilingual('Download Quran Atlas', 'تحميل أطلس القرآن')}</a>
      </div>`;
  }

  const redirectScript = deepLink ? `<script>window.location.href = ${JSON.stringify(deepLink)};</script>` : '';

  return `<!doctype html>
<html lang="en" dir="ltr" data-lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${escapeHtml(pageTitle)}</title>
<meta property="og:title" content="${escapeHtml(ogTitle)}"/>
<meta property="og:description" content="${escapeHtml(ogDescription)}"/>
<meta property="og:type" content="website"/>
<link rel="stylesheet" href="/quran-atlas/assets/css/base.css">
<style>
body { background: linear-gradient(180deg, var(--bg-grad-1) 0%, var(--bg-grad-2) 70%, var(--bg-grad-3) 100%); min-height:100vh; display:flex; flex-direction:column; }
:root[data-theme="dark"] body { background: linear-gradient(180deg, var(--bg-grad-1) 0%, var(--bg-grad-2) 75%, var(--bg-grad-3) 100%); }
@media (prefers-color-scheme: dark) { body { background: linear-gradient(180deg, var(--bg-grad-1) 0%, var(--bg-grad-2) 75%, var(--bg-grad-3) 100%); } }
.nav { background: color-mix(in srgb, var(--bg-grad-1) 78%, transparent); }
main { flex:1; display:flex; align-items:center; justify-content:center; padding:32px 20px; }
.card { background: var(--card); border:1px solid var(--border-solid); border-radius:24px; padding:40px 32px; max-width:420px; width:100%; box-shadow: var(--shadow); text-align:center; display:flex; flex-direction:column; align-items:center; gap:16px; }
.preview-icon { color: var(--accent); }
.error-icon { color: var(--text-muted); }
.subtitle, .error-text { font-size:15px; color: var(--text-secondary); }
.item-box { width:100%; background: var(--surface); border-radius:16px; padding:18px 20px; text-align:left; }
html[data-lang="ar"] .item-box { text-align:right; }
.item-name { font-size:18px; font-weight:600; color: var(--heading); margin-bottom:4px; }
.item-meta { font-size:13.5px; color: var(--text-muted); }
.name-list { margin-top:10px; display:flex; flex-direction:column; gap:4px; }
.name-row { font-size:13.5px; color: var(--text-secondary); }
.name-more { font-size:12.5px; color: var(--text-muted); }
.store-buttons { width:100%; display:flex; flex-direction:column; gap:10px; margin-top:6px; }
.cta { display:inline-flex; align-items:center; justify-content:center; gap:9px; border:none; border-radius:12px; padding:14px 22px; font-size:15px; font-weight:600; font-family:inherit; cursor:pointer; text-decoration:none; }
.cta svg { display:block; flex-shrink:0; }
.cta.primary { background: var(--cta-fill); color: var(--cta-label); }
.cta.secondary-store { background: var(--surface); color: var(--accent); border:1px solid var(--border-solid); }
.learn-more { font-size:13px; color: var(--text-secondary); margin-top:4px; }
footer.site-footer { text-align:center; padding:20px 0 32px; font-size:12px; color: var(--text-muted); }
</style>
</head>
<body>

<nav class="nav">
  <div class="nav-row">
    <a class="brand" href="/quran-atlas" aria-label="Quran Atlas">
      <img src="/quran-atlas/assets/img/crescent.png" alt="" />
      <span data-en>Quran Atlas</span>
      <span data-ar>أطلس القرآن</span>
    </a>
    <div class="nav-actions">
      <button class="pill-btn" id="langToggle" type="button">
        <span data-en>العربية</span>
        <span data-ar>English</span>
      </button>
      <button class="pill-btn" id="themeToggle" type="button" aria-label="Toggle theme">
        <span id="themeIcon">&#9788;</span>
      </button>
    </div>
  </div>
</nav>

<main>
  <div class="card">
    ${bodyHtml}
    <a class="learn-more" href="/quran-atlas">${bilingual('Learn more about Quran Atlas', 'اعرف المزيد عن أطلس القرآن')}</a>
  </div>
</main>

<footer class="site-footer">© 2026 Marsa Digital</footer>

<script>
(function() {
  var root = document.documentElement;
  var THEME_KEY = 'qa-theme', LANG_KEY = 'qa-lang';
  function applyTheme(t) {
    root.setAttribute('data-theme', t);
    document.getElementById('themeIcon').textContent = t === 'dark' ? String.fromCharCode(9789) : String.fromCharCode(9788);
    localStorage.setItem(THEME_KEY, t);
  }
  function applyLang(l) {
    root.setAttribute('lang', l);
    root.setAttribute('dir', l === 'ar' ? 'rtl' : 'ltr');
    root.setAttribute('data-lang', l);
    localStorage.setItem(LANG_KEY, l);
  }
  var savedTheme = localStorage.getItem(THEME_KEY);
  applyTheme(savedTheme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  var savedLang = localStorage.getItem(LANG_KEY) || root.getAttribute('data-lang') || 'en';
  applyLang(savedLang);
  document.getElementById('themeToggle').addEventListener('click', function() {
    applyTheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });
  document.getElementById('langToggle').addEventListener('click', function() {
    applyLang(root.getAttribute('data-lang') === 'ar' ? 'en' : 'ar');
  });
})();
</script>
${redirectScript}
</body>
</html>`;
}

module.exports = async function handler(req, res) {
  const id = typeof req.query.id === 'string' ? req.query.id : undefined;

  let resolutionState = 'not_found';
  let description = null;
  if (id) {
    try {
      const payload = await getShare(id);
      if (payload) {
        description = describePayload(payload);
        resolutionState = description ? 'ok' : 'malformed';
      }
    } catch (err) {
      console.error('import-preview getShare failed:', err instanceof Error ? err.message : String(err));
    }
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(renderPage({ id, resolutionState, description }));
};
