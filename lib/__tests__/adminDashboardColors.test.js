// lib/__tests__/adminDashboardColors.test.js
// Run with: node --test lib/__tests__
//
// quran-atlas/admin.html has no DOM-rendering test anywhere in this
// directory (confirmed by grep before writing this file) — this is
// deliberately a lightweight, static source-text check, matching the
// rest of this codebase's "no browser/jsdom harness" convention, not a
// real rendering test. It exists purely to guard the Take down / Block
// creator color swap against silently reverting.

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const html = fs.readFileSync(path.join(__dirname, '../../quran-atlas/admin.html'), 'utf8');

function classAssignedTo(varName) {
  const re = new RegExp(varName + "\\.className\\s*=\\s*'([^']+)'");
  const match = html.match(re);
  assert.ok(match, `expected to find ${varName}.className = '...' in admin.html`);
  return match[1];
}

test('Take down uses the gold/amber (--warn) treatment, swapped from its original red/--danger', () => {
  assert.equal(classAssignedTo('takedownBtn'), 'btn-warn');
});

test('Block creator uses the dark-orange (--danger) treatment, swapped from its original gold/--warn', () => {
  assert.equal(classAssignedTo('blockBtn'), 'btn-danger');
});

test('--danger and --warn are still distinct, readable colors in both themes (the swap only changes WHICH button gets which, not the palette itself)', () => {
  const darkVars = html.match(/:root\s*\{[^}]*\}/)[0];
  const lightVars = html.match(/:root\[data-theme="light"\]\s*\{[^}]*\}/)[0];
  for (const block of [darkVars, lightVars]) {
    const danger = block.match(/--danger:\s*(#[0-9a-fA-F]{3,6})/)[1];
    const warn = block.match(/--warn:\s*(#[0-9a-fA-F]{3,6})/)[1];
    assert.notEqual(danger.toLowerCase(), warn.toLowerCase());
  }
});

test('focus-visible, disabled, and hover rules remain generic (apply to every button regardless of color class) — nothing color-specific was added that only one of the two buttons would get', () => {
  assert.match(html, /button:focus-visible,\s*a:focus-visible,\s*input:focus-visible\s*\{/);
  assert.match(html, /button:disabled\s*\{\s*opacity:\s*\.5/);
  // No button-specific :hover rule exists for either class — confirms
  // the swap didn't need (and didn't introduce) any per-button override.
  assert.equal(/\.btn-(danger|warn):hover/.test(html), false);
});

test('the Blocked Creators entry point is a labeled, prominent card (not a small ambiguous toggle) and renders a "why blocked" reason', () => {
  assert.match(html, /<p class="blocked-creators-entry-title">Blocked Creators<\/p>/);
  assert.match(html, /id="blockedCreatorsSummary"/);
  // Renders each recorded reason, and an honest "no reason recorded"
  // fallback — never inventing one.
  assert.match(html, /No reason recorded/);
  assert.match(html, /reasonLabel\(r\)/);
});

test('the "Reported content" section exists, is driven by c.triggers (not a general share-browsing list), and reuses the existing preview renderer via the admin-only endpoint', () => {
  assert.match(html, /blocked-creator-triggers/);
  assert.match(html, /c\.triggers/);
  assert.match(html, /View content/);
  // The SAME renderer Open Reports uses — loadTriggerPreview delegates
  // to loadPreviewFromUrl, which is what actually calls
  // renderPreview/AdminPreview.parseSharePayload; there must not be a
  // second, independent rendering implementation for this section.
  assert.match(html, /function loadTriggerPreview\(/);
  assert.match(html, /loadPreviewFromUrl\(/);
  assert.match(html, /\/api\/admin-ui\/creator-trigger-content/);
});
