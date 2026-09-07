'use strict';

const express = require('express');
const { createPool, connectionString, redact } = require('./db');

function createApp(pool) {
  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) =>
    res.json({ ok: true, fixed: process.env.SAMPLE_APP_FIXED === '1' })
  );
  app.use('/products', require('./routes/products')(pool));
  app.use('/cart', require('./routes/cart')(pool));
  app.use('/checkout', require('./routes/checkout')(pool));
  app.use('/orders', require('./routes/orders')(pool));
  return app;
}

if (require.main === module) {
  const pool = createPool();
  const PORT = Number(process.env.PORT || 4000);
  const mode = process.env.SAMPLE_APP_FIXED === '1' ? 'FIXED' : 'BUGGY';

  const server = createApp(pool).listen(PORT, () => {
    console.log(`Sample app (${mode}) listening on http://localhost:${PORT}`);
    console.log(`Database: ${redact(connectionString())}`);
  });

  // A port clash is the most likely startup failure — say so plainly rather
  // than dumping a stack trace.
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `\nPort ${PORT} is already in use.\n\n` +
          `Something else is on it — often Postgres itself if you installed it on 4000.\n` +
          `Start the app on another port and point config/demo.json at it:\n\n` +
          `  set PORT=4100\n  npm run sample:start\n\n` +
          `  then in config/demo.json:  "baseUrl": "http://localhost:4100"\n`
      );
      process.exit(1);
    }
    throw err;
  });
}

module.exports = { createApp };
