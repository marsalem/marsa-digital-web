// api/admin/reports.js
// Marsa Digital web — GET /api/admin/reports: list every currently-open
// report. Admin-only (lib/adminAuth.js) — this is the one endpoint you
// (the operator) call to see what needs review. There is no push
// notification for a new report; see the Stage 3 report's own
// "monitoring" section for the operational process this endpoint
// supports (periodic manual polling), which this file's existence alone
// does not constitute.
//
// LOGGING DISCIPLINE — the response itself includes reporter-written
// `details` (that's the point — you need to read it to act on it), but
// nothing here is ever written to a console.log/error line.

const { rejectUnlessAdmin } = require('../../lib/adminAuth');
const { checkAdminRateLimit } = require('../../lib/rateLimit');
const { listOpenReports } = require('../../lib/reportService');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (rejectUnlessAdmin(req, res)) return;

  const { success: withinRateLimit } = await checkAdminRateLimit(req);
  if (!withinRateLimit) {
    res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    return;
  }

  try {
    const reports = await listOpenReports();
    res.status(200).json({ reports });
  } catch (err) {
    console.error('listOpenReports failed:', err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: 'Could not list reports.' });
  }
};
