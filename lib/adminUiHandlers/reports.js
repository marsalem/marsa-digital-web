// lib/adminUiHandlers/reports.js
// Relocated from api/admin-ui/reports.js — now required by
// api/admin-ui/[action].js (see that file's own header) rather than
// deployed as its own Vercel Function. Logic and security checks below
// are unchanged by the move.
//
// Marsa Digital web — GET /api/admin-ui/reports: list every currently-
// open report, for the admin moderation UI. Session-cookie gated (see
// lib/adminSession.js), NOT the Bearer-token model api/admin/reports.js
// uses — this is a separate, parallel consumer of the exact same
// lib/reportService.js function, calling it directly rather than
// round-tripping through that other route. api/admin/reports.js itself
// is untouched.
//
// Cache-Control: no-store — report content (reporter-written `details`)
// must never be cached by the browser or any intermediary.
//
// LOGGING DISCIPLINE — the response includes reporter-written `details`
// (that's the point), but nothing here is ever written to console.

const { checkAdminRateLimit } = require('../rateLimit');
const { rejectUnlessValidSession } = require('../adminSession');
const { listOpenReports } = require('../reportService');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (await rejectUnlessValidSession(req, res)) return;

  const { success: withinRateLimit } = await checkAdminRateLimit(req);
  if (!withinRateLimit) {
    res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    return;
  }

  res.setHeader('Cache-Control', 'no-store');

  try {
    const reports = await listOpenReports();
    res.status(200).json({ reports });
  } catch (err) {
    console.error('admin-ui listOpenReports failed:', err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: 'Could not list reports.' });
  }
};
