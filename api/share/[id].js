// api/share/[id].js
// Marsa Digital web — GET /api/share/:id: fetch a previously-created
// share by its ID. See index.js's own header for the "only two entry
// points into the Share Service" note, and lib/shareService.js for the
// privacy model (an unguessable link, not an authenticated credential —
// anyone with `id` can read the payload until it expires).
//
// deleteShare exists in lib/shareService.js but isn't wired to a route
// here — nothing calls it yet (see that module's own comment on why
// it's still worth keeping the function itself, ready for whenever a
// "delete my share" feature actually needs it, without a redesign).
//
// LOGGING DISCIPLINE — this handler must never log the fetched payload.
// The one console.error below logs only err.message.

const { getShare } = require('../../lib/shareService');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { id } = req.query;
  if (typeof id !== 'string' || !id) {
    res.status(400).json({ error: 'Missing share id.' });
    return;
  }

  try {
    const payload = await getShare(id);
    if (payload == null) {
      res.status(404).json({ error: 'This share does not exist or has expired.' });
      return;
    }
    res.status(200).json(payload);
  } catch (err) {
    console.error('getShare failed:', err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: 'Could not fetch share.' });
  }
};
