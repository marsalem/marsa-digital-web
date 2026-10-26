// api/report.js
// Marsa Digital web — POST /api/report: file a report against a shared
// link. Public, unauthenticated (anyone with a shareId can report it —
// same "no login on either end" model the rest of this service uses),
// rate-limited.
//
// Deliberately does NOT check whether `shareId` currently resolves to a
// real share before accepting the report — a share that already expired
// naturally, or was reported slightly after expiry, is still worth a
// record existing for (e.g. if the same creator keeps re-sharing similar
// content under new ids). It also means this endpoint's response never
// differs based on whether a given shareId exists, which avoids turning
// "report a shareId" into an oracle for "does this shareId exist" (that
// information is already available via GET /api/share/:id regardless,
// but there's no reason to add a second way to probe it here).
//
// LOGGING DISCIPLINE — never log req.body (reason/details are
// reporter-written free text).

const { createReport } = require('../lib/reportService');
const { checkReportRateLimit } = require('../lib/rateLimit');
const { MAX_SHARE_ID_LENGTH, MAX_REPORT_DETAILS_LENGTH, REPORT_REASONS } = require('../lib/shareConstants');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { success: withinRateLimit } = await checkReportRateLimit(req);
  if (!withinRateLimit) {
    res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    return;
  }

  const body = req.body;
  if (body == null || typeof body !== 'object') {
    res.status(400).json({ error: 'Request body must be a JSON object.' });
    return;
  }

  const { shareId, reason, details } = body;

  if (typeof shareId !== 'string' || !shareId || shareId.length > MAX_SHARE_ID_LENGTH) {
    res.status(400).json({ error: 'A valid shareId is required.' });
    return;
  }
  if (typeof reason !== 'string' || !REPORT_REASONS.includes(reason)) {
    res.status(400).json({ error: `reason must be one of: ${REPORT_REASONS.join(', ')}` });
    return;
  }
  if (details !== undefined && (typeof details !== 'string' || details.length > MAX_REPORT_DETAILS_LENGTH)) {
    res.status(400).json({ error: `details must be a string of at most ${MAX_REPORT_DETAILS_LENGTH} characters.` });
    return;
  }

  try {
    await createReport({ shareId, reason, details });
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('createReport failed:', err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: 'Could not submit report.' });
  }
};
