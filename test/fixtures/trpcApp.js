'use strict';

const http = require('node:http');

/**
 * A tRPC-shaped fixture: dotted procedure paths, input in the query string
 * for queries and the body for mutations, and the JSON-RPC envelope with an
 * optional superjson wrapper.
 *
 * The seeded bug mirrors the REST sample app: transfers are not idempotent,
 * so a client that gives up and retries creates a second one.
 */
function createTrpcApp({ transformer = 'superjson', idempotent = false, prefix = '/api/trpc' } = {}) {
  const accounts = new Map();
  const transfers = [];
  const seenKeys = new Map();

  const wrap = (value) => (transformer ? { json: value } : value);
  const unwrap = (value) =>
    transformer && value && typeof value === 'object' && value.json !== undefined
      ? value.json
      : value;

  const send = (res, status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  const ok = (res, data) => send(res, 200, { result: { data: wrap(data) } });
  const fail = (res, status, message) =>
    send(res, status, { error: { message, code: status, data: { httpStatus: status } } });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith(prefix)) return fail(res, 404, 'not found');

    const procedure = url.pathname.slice(prefix.length).replace(/^\//, '');

    let input;
    if (req.method === 'GET') {
      const raw = url.searchParams.get('input');
      try {
        input = raw ? unwrap(JSON.parse(raw)) : {};
      } catch (_) {
        return fail(res, 400, 'malformed input');
      }
    } else {
      const raw = await new Promise((resolve) => {
        let buf = '';
        req.on('data', (c) => (buf += c));
        req.on('end', () => resolve(buf));
      });
      try {
        input = raw ? unwrap(JSON.parse(raw)) : {};
      } catch (_) {
        return fail(res, 400, 'malformed body');
      }
    }

    const owner = input.owner || input.userId || 'anon';
    if (!accounts.has(owner)) accounts.set(owner, { id: owner, balance: 100000 });

    if (procedure === 'banking.overview') {
      return ok(res, { accounts: [accounts.get(owner)] });
    }

    if (procedure === 'banking.ledger') {
      const mine = transfers.filter((t) => t.owner === owner);
      return ok(res, {
        entries: mine,
        balance: accounts.get(owner).balance
      });
    }

    if (procedure === 'banking.transfer') {
      const key = req.headers['idempotency-key'];
      if (idempotent && key && seenKeys.has(key)) {
        return ok(res, seenKeys.get(key)); // replay, do not create a second
      }

      const amount = Number(input.amount || 0);
      const account = accounts.get(owner);
      account.balance -= amount;

      const transfer = {
        id: `t${transfers.length + 1}`,
        owner,
        amount: -amount,
        reference: input.reference || `ref-${transfers.length + 1}`
      };
      transfers.push(transfer);
      if (key) seenKeys.set(key, transfer);
      return ok(res, transfer);
    }

    return fail(res, 404, `no procedure ${procedure}`);
  });

  return { server, accounts, transfers };
}

async function startTrpcApp(options = {}) {
  const app = createTrpcApp(options);
  await new Promise((r) => app.server.listen(0, r));
  return {
    ...app,
    baseUrl: `http://127.0.0.1:${app.server.address().port}`,
    stop: () => new Promise((r) => app.server.close(r))
  };
}

module.exports = { createTrpcApp, startTrpcApp };
