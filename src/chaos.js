'use strict';

/**
 * Client-side network chaos.
 *
 * Scope, stated honestly: Magnum Opus does not control your application's
 * infrastructure, so it cannot kill your database or partition your cluster.
 * What it CAN model is an unreliable network between client and application —
 * which is precisely what produces the abandonment-and-retry behaviour this
 * whole tool exists to examine.
 *
 * Faults:
 *   delay      the request leaves late, eating into the client's patience
 *   reset      the connection dies mid-flight (an ECONNRESET-shaped failure)
 *   duplicate  the request is sent TWICE, one response discarded
 *
 * `duplicate` is the valuable one. It models a retrying proxy or load
 * balancer, and it tests idempotency with no client retry involved at all —
 * a class of duplicate write that no amount of well-behaved client code
 * prevents.
 *
 * Every draw comes from the actor's seeded stream, so a chaos run is exactly
 * as reproducible as a clean one.
 */

const DEFAULT_FAULTS = { delay: 0.5, reset: 0.25, duplicate: 0.25 };

class ChaosPolicy {
  constructor(config = {}) {
    this.enabled = config.enabled === true;
    this.rate = config.rate ?? 0.1;
    this.faults = config.faults || DEFAULT_FAULTS;
    this.delayMs = config.delayMs || [300, 2500];
    // Chaos on reads is mostly noise; the interesting faults hit writes.
    this.methods = config.methods || ['POST', 'PUT', 'PATCH', 'DELETE'];
  }

  /**
   * Decide whether this request suffers a fault.
   *
   * THREE draws, always, in the same order — IF, WHICH, MAGNITUDE — even
   * when no fault fires and even for faults that have no magnitude. An
   * uneven draw count would advance the actor's stream by a different amount
   * depending on which fault landed, so two runs with the same seed but
   * different fault weights would diverge in unrelated later decisions.
   * Constant cost keeps the stream aligned.
   *
   *   p_i = w_i / Σw   over the configured fault weights
   *
   * @returns {{type: string, delayMs?: number}|null}
   */
  select(method, rng) {
    if (!this.enabled) return null;
    if (!this.methods.includes(method)) return null;

    const roll = rng.float();
    const which = rng.float();
    const magnitude = rng.float();
    if (roll >= this.rate) return null;

    const entries = Object.entries(this.faults).filter(([, w]) => w > 0);
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    if (total <= 0) return null;

    let cumulative = 0;
    for (const [type, weight] of entries) {
      cumulative += weight / total;
      if (which < cumulative) {
        return type === 'delay'
          ? {
              type,
              delayMs: Math.round(
                this.delayMs[0] + magnitude * (this.delayMs[1] - this.delayMs[0])
              )
            }
          : { type };
      }
    }
    return { type: entries[entries.length - 1][0] };
  }
}

module.exports = { ChaosPolicy, DEFAULT_FAULTS };
