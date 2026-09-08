'use strict';

const { query } = require('../db/client');

/**
 * Batched, off-hot-path event writer.
 *
 * Phase 1 awaited a Postgres INSERT inside the actor's timing loop, which
 * injected a database round trip into the very latency measurements the
 * detectors then analysed. Events are now timestamped in-process at the
 * moment they occur, queued, and flushed by a background writer.
 *
 * Flush triggers: queue reaches batchSize, or flushIntervalMs elapses.
 */

const COLUMNS = [
  'event_id',
  'run_id',
  'actor_id',
  'trace_id',
  'parent_event_id',
  'occurred_at',
  'trace_sequence',
  'epoch',
  'event_type',
  'action',
  'outcome',
  'latency_ms',
  'http_status',
  'idempotency_key',
  'attempt_number',
  'payload',
  'tags'
];

class EventBuffer {
  constructor({ batchSize = 500, flushIntervalMs = 250 } = {}) {
    this.batchSize = batchSize;
    this.flushIntervalMs = flushIntervalMs;
    this.queue = [];
    this.inFlight = null;
    this.closed = false;
    this.written = 0;
    this.timer = setInterval(() => {
      this.flush().catch((err) => console.error('Event flush failed:', err.message));
    }, flushIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  push(row) {
    if (this.closed) throw new Error('EventBuffer is closed');
    this.queue.push(row);
    if (this.queue.length >= this.batchSize) {
      this.flush().catch((err) => console.error('Event flush failed:', err.message));
    }
  }

  /**
   * Flushes the current queue as a single multi-row INSERT.
   * Serialised via this.inFlight so batches land in push order — important
   * because parent_event_id references events written in earlier batches.
   */
  async flush() {
    if (this.inFlight) return this.inFlight;
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0, this.queue.length);
    this.inFlight = this._write(batch).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async _write(batch) {
    const params = [];
    const tuples = [];

    batch.forEach((row, i) => {
      const base = i * COLUMNS.length;
      tuples.push('(' + COLUMNS.map((_, c) => `$${base + c + 1}`).join(',') + ')');
      params.push(
        row.event_id,
        row.run_id,
        row.actor_id,
        row.trace_id,
        row.parent_event_id,
        row.occurred_at,
        row.trace_sequence,
        row.epoch ?? 0,
        row.event_type,
        row.action,
        row.outcome,
        row.latency_ms,
        row.http_status,
        row.idempotency_key,
        row.attempt_number,
        row.payload,
        row.tags
      );
    });

    await query(
      `INSERT INTO events (${COLUMNS.join(',')}) VALUES ${tuples.join(',')}`,
      params
    );
    this.written += batch.length;
  }

  /** Flush everything and stop the interval. */
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    while (this.queue.length > 0 || this.inFlight) {
      await this.flush();
      if (this.inFlight) await this.inFlight;
    }
    return this.written;
  }
}

module.exports = { EventBuffer, COLUMNS };
