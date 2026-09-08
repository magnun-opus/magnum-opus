const express = require('express');

module.exports = function (pool) {
  const router = express.Router();

  router.get('/:id', async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  });

  return router;
};
