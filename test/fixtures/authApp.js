'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

/**
 * Fixture application for the Phase 4 features.
 *
 * Written on node:http rather than Express so the test suite needs no
 * dependency of its own — the root package still ships with `pg` alone.
 *
 * Exercises what the domain packs need and the original sample app could
 * not:
 *   - a real login issuing a token, with every other route requiring it
 *   - list endpoints, so `pick: "random"` has something to choose between
 *   - inventory that CAN go negative, so `bounds` has a real bug to catch
 *   - per-user scoping, so isolation has a matched control
 *
 * Each bug is opt-in, so every test can be paired with a clean control.
 */
function createAuthApp({ oversell = false, leakOrders = false } = {}) {
  const tokens = new Map();
  const orders = [];
  const products = [
    { id: 'p1', name: 'Router', priceMinor: 250000, stock: 5 },
    { id: 'p2', name: 'Switch', priceMinor: 480000, stock: 5 },
    { id: 'p3', name: 'Modem', priceMinor: 190000, stock: 5 }
  ];

  const send = (res, status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(payload);
  };

  const readBody = (req) =>
    new Promise((resolve) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch (_) {
          resolve({});
        }
      });
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${url.pathname}`;
    const body = await readBody(req);

    if (route === 'POST /api/auth/login') {
      if (!body.email) return send(res, 400, { error: 'email required' });
      const token = crypto.randomUUID();
      const userId = String(body.email).split('@')[0];
      tokens.set(token, userId);
      return send(res, 200, { token, userId, accountId: userId });
    }

    // Everything below requires a valid bearer token.
    const userId = tokens.get((req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!userId) return send(res, 401, { error: 'unauthorized' });

    if (route === 'GET /api/products') return send(res, 200, { products });

    if (route === 'POST /api/checkout') {
      const product = products.find((p) => p.id === body.productId);
      if (!product) return send(res, 404, { error: 'no such product' });
      const quantity = Number(body.quantity || 1);

      // The seeded bug: with oversell, there is no stock floor, so
      // concurrent buyers drive it negative.
      if (!oversell && product.stock - quantity < 0) {
        return send(res, 409, { error: 'insufficient stock' });
      }
      product.stock -= quantity;

      const order = {
        id: `o${orders.length + 1}`,
        userId,
        productId: product.id,
        quantity,
        totalMinor: product.priceMinor * quantity
      };
      orders.push(order);
      return send(res, 201, order);
    }

    if (route === 'GET /api/orders') {
      const mine = leakOrders ? orders : orders.filter((o) => o.userId === userId);
      return send(res, 200, { orders: mine });
    }

    return send(res, 404, { error: 'not found' });
  });

  return { server, products, orders };
}

/** Start on an ephemeral port and return its base URL. */
async function startAuthApp(options = {}) {
  const app = createAuthApp(options);
  await new Promise((resolve) => app.server.listen(0, resolve));
  return {
    ...app,
    baseUrl: `http://127.0.0.1:${app.server.address().port}`,
    stop: () => new Promise((r) => app.server.close(r))
  };
}

module.exports = { createAuthApp, startAuthApp };
