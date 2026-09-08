'use strict';

/**
 * Turns a database connection failure into something a human can act on.
 *
 * The specific trap this exists for: on Windows, `localhost` resolves to
 * BOTH ::1 and 127.0.0.1. Node tries both, both fail, and wraps them in an
 * AggregateError — whose `.message` is an EMPTY STRING. Any code that logs
 * `err.message` therefore prints a blank line and tells you nothing.
 */
function unwrap(err) {
  if (err && Array.isArray(err.errors) && err.errors.length > 0) {
    // AggregateError: prefer the first child that carries a real message.
    const child = err.errors.find((e) => e && e.message) || err.errors[0];
    return { message: child.message, code: child.code || err.code, aggregate: err.errors };
  }
  return { message: err?.message || String(err), code: err?.code, aggregate: null };
}

const HINTS = {
  ECONNREFUSED: (cs) => [
    'Postgres refused the connection — the server is not running or is on a different port.',
    '',
    'Windows:',
    '  1. Check whether it is installed:   sc query state= all | findstr /i postgres',
    '  2. If a service exists but is stopped:   net start postgresql-x64-16',
    '  3. If nothing is installed, either install PostgreSQL from',
    '     https://www.postgresql.org/download/windows/  (tick "Command Line Tools"),',
    '     or run it in Docker:',
    '       docker run --name magnum-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:16',
    '',
    `Connection attempted: ${redact(cs)}`
  ],
  ENOTFOUND: (cs) => [
    'The database host could not be resolved.',
    `Check the host in your connection string: ${redact(cs)}`
  ],
  '28P01': (cs) => [
    'Password authentication failed.',
    'Set the correct credentials in .env, for example:',
    '  MAGNUM_OPUS_DB_URL=postgres://postgres:YOURPASSWORD@127.0.0.1:5432/magnum_opus',
    `Connection attempted: ${redact(cs)}`
  ],
  '28000': (cs) => [
    'The database rejected that role.',
    'On Windows the default superuser is "postgres", not your Windows username.',
    'Set an explicit user in .env:',
    '  MAGNUM_OPUS_DB_URL=postgres://postgres:YOURPASSWORD@127.0.0.1:5432/magnum_opus',
    `Connection attempted: ${redact(cs)}`
  ],
  '3D000': (cs) => [
    'That database does not exist yet.',
    'Create both databases without needing createdb on your PATH:',
    '  npm run db:create',
    `Connection attempted: ${redact(cs)}`
  ]
};

/** Strip the password before anything reaches a log or a terminal. */
function redact(connectionString) {
  if (!connectionString) return '(none)';
  return String(connectionString).replace(/:\/\/([^:@/]+):([^@]*)@/, '://$1:****@');
}

function describeConnectionError(err, connectionString) {
  const { message, code, aggregate } = unwrap(err);
  const lines = [`Database error: ${message || '(no message provided)'}`];
  if (code) lines.push(`Code: ${code}`);

  const hint = HINTS[code];
  if (hint) lines.push('', ...hint(connectionString));
  else lines.push('', `Connection attempted: ${redact(connectionString)}`);

  if (aggregate && aggregate.length > 1) {
    lines.push('', 'All attempted addresses failed:');
    for (const e of aggregate) lines.push(`  - ${e.message}`);
  }

  return lines.join('\n');
}

module.exports = { describeConnectionError, unwrap, redact };
