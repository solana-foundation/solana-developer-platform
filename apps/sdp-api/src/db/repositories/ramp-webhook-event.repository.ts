import type { RampWebhookEventStatus, SdpEnvironment } from "@sdp/types";
import type { RampProviderId } from "@sdp/types/provider-access";
import type { AppDb } from "@/db";

export function generateRampWebhookEventId(): string {
  return `rwe_${crypto.randomUUID()}`;
}

export interface RampWebhookEventRow {
  id: string;
  provider: RampProviderId;
  environment: SdpEnvironment;
  /** The signature-verified provider payload, exactly as `verify` returned it. */
  payload: unknown;
  status: RampWebhookEventStatus;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface InsertRampWebhookEventInput {
  provider: RampProviderId;
  environment: SdpEnvironment;
  payload: unknown;
}

export interface ClaimReplayableRampWebhookEventsInput {
  /** Only rows created — and last touched — at or before this instant are
   * claimed. The created_at bound keeps the claim off events whose in-request
   * background apply is still due; the updated_at bound is a lease, so a row
   * another pass claimed or failed within the window is not re-run
   * concurrently. A double apply past the lease is safe for settlements (CAS)
   * and bounded for provisioning (deterministic provider references). */
  createdBefore: string;
  maxAttempts: number;
  limit: number;
}

export interface RecordRampWebhookEventFailureInput {
  id: string;
  error: string;
  /** Attempts spent INCLUDING the one that just failed; at or past
   * `maxAttempts` the row is parked as `failed` for an operator. */
  attempts: number;
  maxAttempts: number;
  /** The application revision doing the parking; stamped only when the row
   * parks, so the replay job can re-arm it after the next deploy. */
  appRevision: string;
}

export interface ParkExhaustedRampWebhookEventsInput {
  /** Lease bound: only rows untouched since this instant are parked, so a
   * final attempt still running is not swept out from under its worker. */
  updatedBefore: string;
  maxAttempts: number;
  appRevision: string;
}

export interface RampWebhookEventsRepository {
  /** Persists a verified event; runs before the webhook is acked. */
  insertEvent(input: InsertRampWebhookEventInput): Promise<RampWebhookEventRow>;
  /** Discharges a delivered event. The row is deleted, not archived: the
   * settlement itself is the durable record, and deleting bounds how long a
   * raw provider payload stays at rest. */
  deleteEvent(id: string): Promise<void>;
  /** Records a failed apply. Below `maxAttempts` the row stays `pending` for
   * the replay job; at the limit it parks as `failed`. */
  recordFailure(input: RecordRampWebhookEventFailureInput): Promise<void>;
  /**
   * Claims a batch of pending rows for replay, incrementing `attempts` in the
   * same statement. `SKIP LOCKED` keeps two concurrently running replay passes
   * from applying the same event; the settlement CAS makes a double apply
   * harmless, so the lock only avoids wasted work and double-counted attempts.
   */
  claimReplayable(input: ClaimReplayableRampWebhookEventsInput): Promise<RampWebhookEventRow[]>;
  /**
   * Parks pending rows whose attempts are already spent — the state a crash
   * leaves when the final claim committed but the apply or its failure record
   * never ran. Without this sweep such rows stay pending forever while every
   * claim excludes them.
   */
  parkExhausted(input: ParkExhaustedRampWebhookEventsInput): Promise<RampWebhookEventRow[]>;
  /**
   * Re-arms rows parked by a DIFFERENT application revision: the deploy that
   * replaced it may carry the fix, so the row goes back to pending with fresh
   * attempts and the minutely replay retries it. A row parked by the current
   * revision stays parked — retrying the same code against the same payload
   * only burns attempts.
   */
  rearmParkedByOtherRevisions(appRevision: string): Promise<RampWebhookEventRow[]>;
}

function mapRow(row: Record<string, unknown>): RampWebhookEventRow {
  return {
    id: row.id as string,
    provider: row.provider as RampProviderId,
    environment: row.environment as SdpEnvironment,
    // JSONB comes back decoded; a provider whose payload IS a string (a raw
    // signed body) must get that exact string back, never a re-parse of it.
    payload: row.payload,
    status: row.status as RampWebhookEventStatus,
    attempts: Number(row.attempts),
    last_error: (row.last_error as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function createPostgresRampWebhookEventsRepository(db: AppDb): RampWebhookEventsRepository {
  return {
    async insertEvent(input) {
      const row = await db
        .prepare(
          `INSERT INTO ramp_webhook_events (id, provider, environment, payload)
           VALUES (?, ?, ?, ?)
           RETURNING *`
        )
        .bind(
          generateRampWebhookEventId(),
          input.provider,
          input.environment,
          JSON.stringify(input.payload)
        )
        .first<Record<string, unknown>>();
      if (!row) {
        throw new Error("ramp webhook event insert returned no row");
      }
      return mapRow(row);
    },

    async deleteEvent(id) {
      await db.prepare("DELETE FROM ramp_webhook_events WHERE id = ?").bind(id).run();
    },

    async recordFailure(input) {
      // GREATEST keeps attempts monotonic: a slow background apply finishing
      // after a replay claim already advanced the count must not wind it back
      // and postpone the parking threshold.
      await db
        .prepare(
          `UPDATE ramp_webhook_events
             SET attempts = GREATEST(attempts, ?),
                 last_error = ?,
                 status = CASE WHEN GREATEST(attempts, ?) >= ? THEN 'failed' ELSE status END,
                 parked_app_revision = CASE WHEN GREATEST(attempts, ?) >= ? THEN ? ELSE parked_app_revision END,
                 updated_at = sdp_iso_now()
           WHERE id = ?`
        )
        .bind(
          input.attempts,
          input.error,
          input.attempts,
          input.maxAttempts,
          input.attempts,
          input.maxAttempts,
          input.appRevision,
          input.id
        )
        .run();
    },

    async claimReplayable(input) {
      const result = await db
        .prepare(
          `UPDATE ramp_webhook_events
             SET attempts = attempts + 1, updated_at = sdp_iso_now()
           WHERE id IN (
             SELECT id FROM ramp_webhook_events
              WHERE status = 'pending' AND created_at <= ? AND updated_at <= ? AND attempts < ?
              ORDER BY created_at ASC
              LIMIT ?
              FOR UPDATE SKIP LOCKED
           )
           RETURNING *`
        )
        .bind(input.createdBefore, input.createdBefore, input.maxAttempts, input.limit)
        .all<Record<string, unknown>>();
      return result.results.map(mapRow);
    },

    async parkExhausted(input) {
      const result = await db
        .prepare(
          `UPDATE ramp_webhook_events
             SET status = 'failed', parked_app_revision = ?, updated_at = sdp_iso_now()
           WHERE status = 'pending' AND attempts >= ? AND updated_at <= ?
           RETURNING *`
        )
        .bind(input.appRevision, input.maxAttempts, input.updatedBefore)
        .all<Record<string, unknown>>();
      return result.results.map(mapRow);
    },

    async rearmParkedByOtherRevisions(appRevision) {
      const result = await db
        .prepare(
          `UPDATE ramp_webhook_events
             SET status = 'pending', attempts = 0, parked_app_revision = NULL,
                 updated_at = sdp_iso_now()
           WHERE status = 'failed' AND parked_app_revision IS DISTINCT FROM ?
           RETURNING *`
        )
        .bind(appRevision)
        .all<Record<string, unknown>>();
      return result.results.map(mapRow);
    },
  };
}
