'use strict';

const express = require('express');

/**
 * Read-back endpoint, used by probes to compare what the application stored
 * against what the simulated actor intended.
 *
 * SAMPLE_APP_LEAK=1 introduces a second seeded bug: the tenant filter is
 * dropped, so every session sees every order. This is the classic missing
 * WHERE clause, and it is what the isolation detector exists to catch.
 * Unlike the idempotency bug it is invisible to a single-user test — you
 * only see it when more than one actor exists at the same time.
 */
module.exports = function (pool) {
  const router = express.Router();
  const leak = process.env.SAMPLE_APP_LEAK === '1';

  // SAMPLE_APP_SCAN=1 introduces a third seeded bug, and the only one that is
  // invisible until data accumulates. Wrapping the indexed column in an
  // expression defeats the index, so Postgres falls back to a sequential
  // scan. At a hundred orders nobody notices. At fifty thousand it is the
  // slowest endpoint in the application.
  const scan = process.env.SAMPLE_APP_SCAN === '1';

  router.get('/', async (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    let rows;
    if (leak) {
      ({ rows } = await pool.query(
        'SELECT id, session_id, total_cents, created_at FROM orders ORDER BY id ASC LIMIT 50'
      ));
    } else if (scan) {
      ({ rows } = await pool.query(
        `SELECT id, session_id, total_cents, created_at
           FROM orders
          WHERE upper(session_id) = upper($1)
          ORDER BY id ASC`,
        [sessionId]
      ));
    } else {
      ({ rows } = await pool.query(
        'SELECT id, session_id, total_cents, created_at FROM orders WHERE session_id = $1 ORDER BY id ASC',
        [sessionId]
      ));
    }

    res.json({ sessionId, orders: rows, count: rows.length });
  });

  return router;
};
