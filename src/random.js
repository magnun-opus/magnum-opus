'use strict';

/**
 * Deterministic randomness for reproducible simulation runs.
 *
 * Design note — why per-actor streams:
 * A single shared PRNG is NOT reproducible under concurrency. Actors
 * interleave in a nondeterministic order, so the order in which they draw
 * from a shared stream varies between runs even with an identical seed.
 * Instead we derive one independent stream per actor from (runSeed, index).
 * Each actor consumes only its own stream, in the fixed order dictated by
 * its own state machine, so interleaving no longer affects the outcome.
 */

/**
 * xmur3: string -> 32-bit seed generator. Used to turn a human-readable
 * seed ("nightly-2026-09-04") into the integer state mulberry32 needs.
 */
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/**
 * mulberry32: fast 32-bit counter PRNG. Returns a float in [0, 1).
 *   t = (state += 0x6D2B79F5)
 *   t = imul(t ^ (t >>> 15), t | 1)
 *   t ^= t + imul(t ^ (t >>> 7), t | 61)
 *   return ((t ^ (t >>> 14)) >>> 0) / 2**32
 */
function mulberry32(seedInt) {
  let a = seedInt >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A named random stream with the helpers the simulation actually needs.
 * Every draw is a pure function of (seed, number of prior draws).
 */
class RandomStream {
  constructor(seedString) {
    this.seedString = seedString;
    this._next = mulberry32(xmur3(seedString)());
    this.draws = 0;
  }

  /** Uniform float in [0, 1). */
  float() {
    this.draws++;
    return this._next();
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min, max) {
    return Math.floor(min + this.float() * (max - min + 1));
  }

  /** Uniform float in [min, max). */
  range(min, max) {
    return min + this.float() * (max - min);
  }

  /** Uniform choice from a non-empty array. */
  pick(arr) {
    if (!Array.isArray(arr) || arr.length === 0) {
      throw new Error('RandomStream.pick requires a non-empty array');
    }
    return arr[this.int(0, arr.length - 1)];
  }

  /**
   * Exponentially distributed delay for a Poisson arrival process.
   * Inverse-transform sampling: t = -ln(1 - u) / lambda
   * where lambda is the arrival rate per second. Returns milliseconds.
   */
  exponentialDelayMs(ratePerSecond) {
    if (!(ratePerSecond > 0)) return 0;
    const u = this.float();
    return (-Math.log(1 - u) / ratePerSecond) * 1000;
  }
}

/**
 * Derive the stream for actor #index from the run seed. Deterministic and
 * independent of how many other actors exist or when they run.
 */
function actorStream(runSeed, index) {
  return new RandomStream(`${runSeed}:actor:${index}`);
}

/** Generate a fresh seed when the operator doesn't supply one. */
function generateSeed() {
  return `run-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

module.exports = { xmur3, mulberry32, RandomStream, actorStream, generateSeed };
