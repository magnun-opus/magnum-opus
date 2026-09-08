'use strict';

const express = require('express');
const { xmur3, mulberry32 } = require('../../src/random');

/**
 * Two modes, selected by SAMPLE_APP_FIXED:
 *
 *   BUGGY (default) — no idempotency handling. A client that gives up and
 *   retries creates a second order. This is what the detectors must catch.
 *
 *   FIXED (SAMPLE_APP_FIXED=1) — honours the Idempotency-Key header: a
 *   repeated key returns the original order instead of creating a new one.
 *   This is what proves the detectors do not fire on a correct application.
 *
 * Slow-request injection is seeded rather than Math.random(), so a run with
 * a given seed exercises the same latency pattern every time.
 */
module.exports = function (pool) {
  const router = express.Router();
  const fixed = process.env.SAMPLE_APP_FIXED === '1';
  const slowProbability = Number(process.env.SAMPLE_APP_SLOW_RATE || 0.45);
  const slowDelayMs = Number(process.env.SAMPLE_APP_SLOW_MS || 2200);
  const appSeed = process.env.SAMPLE_APP_SEED || 'demo';

  /** Deterministic per (session, attempt): same input, same latency. */
  function isSlow(sessionId, attemptTag) {
    const rng = mulberry32(xmur3(`${appSeed}:${sessionId}:${attemptTag}`)());
    return rng() < slowProbability;
  }

  router.post('/', async (req, res) => {
    const sessionId = req.body.sessionId || 'sim-session';
    const idempotencyKey = req.get('Idempotency-Key') || null;

    if (fixed && idempotencyKey) {
      // Claim the key first. The unique index makes concurrent duplicates
      // collide rather than race.
      const claim = await pool.query(
        `INSERT INTO idempotency_keys (key, session_id)
         VALUES ($1,$2)
         ON CONFLICT (key) DO NOTHING
         RETURNING key`,
        [idempotencyKey, sessionId]
      );

      if (claim.rowCount === 0) {
        // Key already used — return the original order, do not create another.
        const { rows } = await pool.query(
          `SELECT o.id, o.total_cents
             FROM idempotency_keys k
             JOIN orders o ON o.id = k.order_id
            WHERE k.key = $1`,
          [idempotencyKey]
        );
        if (rows.length > 0) {
          return res
            .status(200)
            .json({ ok: true, orderId: rows[0].id, totalCents: rows[0].total_cents, replayed: true });
        }
        // The original request is still in flight; wait briefly for it.
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 100));
          const retry = await pool.query(
            `SELECT o.id, o.total_cents
               FROM idempotency_keys k
               JOIN orders o ON o.id = k.order_id
              WHERE k.key = $1`,
            [idempotencyKey]
          );
          if (retry.rows.length > 0) {
            return res.status(200).json({
              ok: true,
              orderId: retry.rows[0].id,
              totalCents: retry.rows[0].total_cents,
              replayed: true
            });
          }
        }
        return res.status(409).json({ error: 'idempotent request still in progress' });
      }
    }

    // Load-dependent latency: some requests outlive a typical client's patience.
    if (isSlow(sessionId, idempotencyKey || 'none')) {
      await new Promise((r) => setTimeout(r, slowDelayMs));
    }

    const { rows: cartRows } = await pool.query(
      `SELECT ci.quantity, p.price_cents
         FROM cart_items ci
         JOIN products p ON p.id = ci.product_id
        WHERE ci.session_id = $1`,
      [sessionId]
    );

    const total = cartRows.reduce((sum, r) => sum + r.price_cents * r.quantity, 0) || 2499;

    const { rows } = await pool.query(
      'INSERT INTO orders (session_id, total_cents) VALUES ($1,$2) RETURNING id',
      [sessionId, total]
    );

    if (fixed && idempotencyKey) {
      await pool.query('UPDATE idempotency_keys SET order_id = $2 WHERE key = $1', [
        idempotencyKey,
        rows[0].id
      ]);
    }

    // BUGGY MODE: no key check happened above, so a retry lands here again
    // and inserts a second order for the same logical checkout.
    res.status(201).json({ ok: true, orderId: rows[0].id, totalCents: total });
  });

  return router;
};
