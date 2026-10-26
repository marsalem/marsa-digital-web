// lib/__tests__/importPreviewReport.test.js
// Run with: node --test lib/__tests__
//
// Tests the web-side "Report this content" markup rendered by
// api/import-preview.js — the surface a recipient without the app
// installed actually lands on. Uses the handler's own exposed
// describePayload/reportSectionHtml (see that file's own comment on why
// they're attached to the exported function rather than duplicated
// here) plus a full end-to-end render via the handler itself.

process.env.UPSTASH_REDIS_REST_URL ||= 'https://example.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN ||= 'test-token';

const test = require('node:test');
const assert = require('node:assert/strict');

const shareService = require('../shareService');
const rateLimit = require('../rateLimit');

let fakeShare = null;
shareService.getShare = async () => fakeShare;
rateLimit.checkReadShareRateLimit = async () => ({ success: true });

const handler = require('../../api/import-preview.js');

function render(id) {
  let html = '';
  const res = { setHeader: () => {}, status: () => res, send: (body) => { html = body; } };
  return handler({ query: { id } }, res).then(() => html);
}

test('reportSectionHtml embeds the shareId as an HTML-escaped data attribute', () => {
  const html = handler.reportSectionHtml('abc"123<script>');
  assert.match(html, /data-share-id="abc&quot;123&lt;script&gt;"/);
});

test('reportSectionHtml includes exactly the 5 reasons api/report.js accepts', () => {
  const html = handler.reportSectionHtml('abc123');
  for (const reason of ['hate_speech', 'harassment', 'sexual_content', 'spam', 'other']) {
    assert.match(html, new RegExp(`value="${reason}"`));
  }
});

// Note: `/report-section/` alone is NOT a sufficient check — the CSS
// rules for .report-section are static and always present in <style>
// regardless of whether the element itself is rendered. Checking for the
// actual data-share-id attribute (only ever emitted by
// reportSectionHtml's own markup, never by the stylesheet) is what
// distinguishes "the element was rendered" from "the CSS class exists".

test('a resolved share (resolutionState=ok) renders the report section', async () => {
  fakeShare = { type: 'qatlas_playlist', playlist: { name: 'Morning Recitation', items: [] } };
  const html = await render('abc123');
  assert.match(html, /data-share-id="abc123"/);
});

test('an expired/not-found share does NOT render the report section', async () => {
  fakeShare = null;
  const html = await render('gone-id');
  assert.doesNotMatch(html, /data-share-id=/);
});

test('a malformed/unrecognized payload shape does NOT render the report section', async () => {
  fakeShare = { type: 'something_unrecognized' };
  const html = await render('weird-id');
  assert.doesNotMatch(html, /data-share-id=/);
});
