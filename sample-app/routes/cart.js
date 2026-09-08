const express = require('express');

module.exports = function (pool) {
  const router = express.Router();

  router.post('/', async (req, res) => {
    // Session id is normally derived from auth/cookies; simulation sends one explicitly.
    const sessionId = req.body.sessionId || 'sim-session';
    const productId = req.body.productId || 1;
    const quantity = req.body.quantity || 1;

    await pool.query(
      'INSERT INTO cart_items (session_id, product_id, quantity) VALUES ($1,$2,$3)',
      [sessionId, productId, quantity]
    );

    res.status(201).json({ ok: true, sessionId });
  });

  return router;
};
