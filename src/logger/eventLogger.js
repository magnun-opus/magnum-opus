'use strict';

const crypto = require('crypto');
const { query } = require('../db/client');

/**
 * EventLogger is bound to a single run/actor/trace and writes into a shared
 * EventBuffer. log() is synchronous: it stamps occurred_at in-process,
 * assigns a per-trace sequence number, queues the row and returns the
 * event id immediately. No database latency enters the actor's timing loop.
 *
 * trace_sequence is the per-trace ordinal. Combined with actor_index it
 * forms the stable logical key used to diff two runs of the same seed
 * (UUIDs deliberately are not stable — see src/random.js).
 */
class EventLogger {
  constructor(runId, actorId, traceId, buffer, epoch = 0) {
    this.runId = runId;
    this.actorId = actorId;
    this.traceId = traceId;
    this.buffer = buffer;
    this.epoch = epoch;
    this.sequence = 0;
  }

  /**
   * @param {object} evt
   * @param {string} evt.eventType  http_request | late_response | decision | wait | verification
   * @param {string} evt.action     e.g. 'POST /checkout'
   * @param {string} [evt.outcome]  success | timeout | error | abandoned
   * @param {number} [evt.latencyMs]
   * @param {number} [evt.httpStatus]
   * @param {string} [evt.idempotencyKey]
   * @param {number} [evt.attempt]
   * @param {object} [evt.payload]
   * @param {string[]} [evt.tags]
   * @param {string} [evt.parentEventId]
   * @returns {string} event_id
   */
  log(evt) {
    const eventId = crypto.randomUUID();
    this.buffer.push({
      event_id: eventId,
      run_id: this.runId,
      actor_id: this.actorId,
      trace_id: this.traceId,
      parent_event_id: evt.parentEventId || null,
      occurred_at: new Date(),
      trace_sequence: ++this.sequence,
      epoch: this.epoch,
      event_type: evt.eventType,
      action: evt.action,
      outcome: evt.outcome || null,
      latency_ms: evt.latencyMs != null ? Math.round(evt.latencyMs) : null,
      http_status: evt.httpStatus != null ? evt.httpStatus : null,
      idempotency_key: evt.idempotencyKey || null,
      attempt_number: evt.attempt != null ? evt.attempt : null,
      payload: evt.payload ? JSON.stringify(evt.payload) : null,
      tags: evt.tags || []
    });
    return eventId;
  }

  static async addTag(eventId, tag) {
    await query(
      `UPDATE events SET tags = array_append(tags, $2) WHERE event_id = $1 AND NOT ($2 = ANY(tags))`,
      [eventId, tag]
    );
  }
}

module.exports = EventLogger;
