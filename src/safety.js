'use strict';

/**
 * Target-host guard.
 *
 * Magnum Opus deliberately abandons requests mid-flight and retries payment
 * intents. Pointed at production that is not a test, it is an incident. This
 * refuses non-local targets unless the operator makes TWO independent
 * gestures: an explicit allowedHosts entry in config, AND the
 * --i-know-this-is-not-production flag. One alone is too easy to leave
 * sitting in a committed CI file.
 */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/** RFC1918 / RFC4193 / link-local ranges — a private LAN, not the internet. */
function isPrivateAddress(host) {
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;
  return false;
}

function classifyHost(host) {
  const h = String(host).toLowerCase();
  if (LOOPBACK.has(h)) return 'loopback';
  if (h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.test')) return 'loopback';
  if (isPrivateAddress(h)) return 'private';
  return 'public';
}

/**
 * @returns {{allowed: boolean, classification: string, reason?: string}}
 */
function checkTarget(baseUrl, { allowedHosts = [], acknowledged = false } = {}) {
  let host;
  try {
    host = new URL(baseUrl).hostname;
  } catch (_) {
    return { allowed: false, classification: 'invalid', reason: `Not a valid URL: ${baseUrl}` };
  }

  const classification = classifyHost(host);
  if (classification === 'loopback' || classification === 'private') {
    return { allowed: true, classification };
  }

  const listed = allowedHosts.map((h) => String(h).toLowerCase()).includes(host.toLowerCase());

  if (listed && acknowledged) return { allowed: true, classification };

  const missing = [];
  if (!listed) missing.push(`add "${host}" to "allowedHosts" in your config file`);
  if (!acknowledged) missing.push('pass --i-know-this-is-not-production');

  return {
    allowed: false,
    classification,
    reason:
      `Refusing to run against the non-local host "${host}".\n\n` +
      `Magnum Opus abandons requests mid-flight and retries write intents. Against a\n` +
      `live system that is an incident, not a test.\n\n` +
      `To proceed you must do BOTH:\n` +
      missing.map((m) => `  - ${m}`).join('\n') +
      `\n\nIf this is a staging environment, that is exactly what those two steps are for.`
  };
}

function assertTargetAllowed(baseUrl, options) {
  const result = checkTarget(baseUrl, options);
  if (!result.allowed) {
    const err = new Error(result.reason);
    err.code = 'MAGNUM_UNSAFE_TARGET';
    throw err;
  }
  return result;
}

module.exports = { checkTarget, assertTargetAllowed, classifyHost, isPrivateAddress };
