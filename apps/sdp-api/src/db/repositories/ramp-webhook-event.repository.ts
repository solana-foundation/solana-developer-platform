import type { SdpEnvironment } from "@sdp/types/api-keys";
import {
  RAMP_WEBHOOK_APPLY_OUTCOMES,
  RAMP_WEBHOOK_EVENT_STATUSES,
  type RampWebhookApplyOutcome,
  type RampWebhookDischargeOutcome,
  type RampWebhookEventStatus,
  type RampWebhookFailureOutcome,
} from "@sdp/types/payments";
import {
  PERSISTED_RAMP_PROVIDERS,
  type PersistedRampProviderId,
  type RampProviderId,
} from "@sdp/types/provider-access";
import { z } from "zod";
import type { DatabaseClient as AppDb } from "@/db/client";

export function generateRampWebhookEventId(): string {
  return `rwe_${crypto.randomUUID()}`;
}

export interface RampWebhookEventRow {
  id: string;
  /** A retired provider's row still reads, and parks for want of a processor. */
  provider: PersistedRampProviderId;
  environment: SdpEnvironment;
  /** Verified provider body, retained only until the event is discharged. */
  rawBody: string;
  providerEventId: string | null;
  applyOutcome: RampWebhookApplyOutcome | null;
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

export interface InsertVerifiedRampWebhookEventInput {
  provider: RampProviderId;
  environment: SdpEnvironment;
  rawBody: string;
  providerEventId: string | null;
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
  /** Rows from these providers are never claimed (their release channel leaves them out). */
  excludedProviders: readonly RampProviderId[];
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
  /** A permanent failure: the row parks as terminal and no deploy re-arms it. */
  terminal?: boolean;
  outcome?: RampWebhookFailureOutcome;
}

export interface ParkExhaustedRampWebhookEventsInput {
  /** Lease bound: only rows untouched since this instant are parked, so a
   * final attempt still running is not swept out from under its worker. */
  updatedBefore: string;
  maxAttempts: number;
  appRevision: string;
  /** Rows from these providers are never parked. */
  excludedProviders: readonly RampProviderId[];
}

export interface RearmRampWebhookEventsInput {
  appRevision: string;
  /** Rows from these providers are never re-armed. */
  excludedProviders: readonly RampProviderId[];
}

export interface RampWebhookEventsRepository {
  /** Legacy JSONB fixture and compatibility writer. New ingress uses signed bytes. */
  insertEvent(input: InsertRampWebhookEventInput): Promise<RampWebhookEventRow>;
  /** Persists a verified body before ack. A duplicate provider event returns its existing row. */
  insertVerifiedEvent(
    input: InsertVerifiedRampWebhookEventInput
  ): Promise<{ row: RampWebhookEventRow; inserted: boolean }>;
  /** Retains the outcome until the retention job archives the discharged row. */
  dischargeEvent(id: string, outcome: RampWebhookDischargeOutcome, reason?: string): Promise<void>;
  archiveDischarged(before: string, limit: number): Promise<number>;
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
  rearmParkedByOtherRevisions(input: RearmRampWebhookEventsInput): Promise<RampWebhookEventRow[]>;
}

const storedEventProviderSchema = z.enum(PERSISTED_RAMP_PROVIDERS);
const storedEventOutcomeSchema = z.enum(RAMP_WEBHOOK_APPLY_OUTCOMES).nullable();
const storedEventStatusSchema = z.enum(RAMP_WEBHOOK_EVENT_STATUSES);

/**
 * The claim, park and re-arm statements take only rows whose provider this
 * deployment can parse. A row from a provider it does not know (written by a
 * newer deploy, read across a rollback) stays exactly as it is for the
 * deployment that does, instead of failing every replay pass that claims it.
 */
const KNOWN_PROVIDERS: string[] = [...PERSISTED_RAMP_PROVIDERS];

function replayBody(row: Record<string, unknown>): string {
  const status = storedEventStatusSchema.parse(row.status);
  switch (status) {
    case "discharged":
    case "archived":
      return "";
    case "pending":
    case "failed": {
      const rawBody = z.string().nullable().parse(row.raw_body);
      if (rawBody !== null) {
        return rawBody;
      }
      const stringPayload = z.string().safeParse(row.payload);
      if (stringPayload.success) {
        return stringPayload.data;
      }
      const jsonPayload = z.json().safeParse(row.payload);
      if (jsonPayload.success && jsonPayload.data !== null) {
        return JSON.stringify(jsonPayload.data);
      }
      throw new Error("active ramp webhook event has no replay body");
    }
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function mapRow(row: Record<string, unknown>): RampWebhookEventRow {
  return {
    id: row.id as string,
    provider: storedEventProviderSchema.parse(row.provider),
    environment: row.environment as SdpEnvironment,
    rawBody: replayBody(row),
    providerEventId: z.string().nullable().parse(row.provider_event_id),
    applyOutcome: storedEventOutcomeSchema.parse(row.apply_outcome),
    status: storedEventStatusSchema.parse(row.status),
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

    async insertVerifiedEvent(input) {
      const row = await db
        .prepare(
          `INSERT INTO ramp_webhook_events
             (id, provider, environment, raw_body, provider_event_id)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (provider, environment, provider_event_id)
             WHERE status <> 'archived' AND provider_event_id IS NOT NULL
           DO NOTHING
           RETURNING *`
        )
        .bind(
          generateRampWebhookEventId(),
          input.provider,
          input.environment,
          input.rawBody,
          input.providerEventId
        )
        .first<Record<string, unknown>>();
      if (row) {
        return { row: mapRow(row), inserted: true };
      }
      const existing = await db
        .prepare(
          `SELECT * FROM ramp_webhook_events
           WHERE provider = ? AND environment = ? AND provider_event_id = ?`
        )
        .bind(input.provider, input.environment, input.providerEventId)
        .first<Record<string, unknown>>();
      if (!existing) {
        throw new Error("ramp webhook event dedupe returned no row");
      }
      return { row: mapRow(existing), inserted: false };
    },

    async dischargeEvent(id, outcome, reason) {
      await db
        .prepare(
          `UPDATE ramp_webhook_events
           SET status = 'discharged', apply_outcome = ?, last_error = ?,
               raw_body = NULL, payload = NULL, discharged_at = sdp_iso_now(),
               updated_at = sdp_iso_now()
           WHERE id = ? AND status = 'pending'`
        )
        .bind(outcome, reason ?? null, id)
        .run();
    },

    async archiveDischarged(before, limit) {
      const result = await db
        .prepare(
          `UPDATE ramp_webhook_events
           SET status = 'archived', apply_outcome = NULL, last_error = NULL,
               provider_event_id = NULL, updated_at = sdp_iso_now()
           WHERE id IN (
             SELECT id FROM ramp_webhook_events
             WHERE status = 'discharged' AND discharged_at <= ?
             ORDER BY discharged_at ASC
             LIMIT ? FOR UPDATE SKIP LOCKED
           ) RETURNING id`
        )
        .bind(before, limit)
        .all<{ id: string }>();
      return result.results.length;
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
                 terminal = ?,
                 apply_outcome = ?,
                 updated_at = sdp_iso_now()
           WHERE id = ? AND status = 'pending'`
        )
        .bind(
          input.attempts,
          input.error,
          input.attempts,
          input.maxAttempts,
          input.attempts,
          input.maxAttempts,
          input.appRevision,
          input.terminal === true,
          input.outcome ?? "retryable_error",
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
                AND provider = ANY(?::text[]) AND provider <> ALL(?::text[])
              ORDER BY created_at ASC
              LIMIT ?
              FOR UPDATE SKIP LOCKED
           )
           RETURNING *`
        )
        .bind(
          input.createdBefore,
          input.createdBefore,
          input.maxAttempts,
          KNOWN_PROVIDERS,
          [...input.excludedProviders],
          input.limit
        )
        .all<Record<string, unknown>>();
      return result.results.map(mapRow);
    },

    async parkExhausted(input) {
      const result = await db
        .prepare(
          `UPDATE ramp_webhook_events
             SET status = 'failed', parked_app_revision = ?, updated_at = sdp_iso_now()
           WHERE status = 'pending' AND attempts >= ? AND updated_at <= ?
             AND provider = ANY(?::text[]) AND provider <> ALL(?::text[])
           RETURNING *`
        )
        .bind(input.appRevision, input.maxAttempts, input.updatedBefore, KNOWN_PROVIDERS, [
          ...input.excludedProviders,
        ])
        .all<Record<string, unknown>>();
      return result.results.map(mapRow);
    },

    async rearmParkedByOtherRevisions(input) {
      // Same batch and lock discipline as the claim path: bounded per pass —
      // the parked set is small by nature, and the next minutely pass takes
      // the rest — and SKIP LOCKED so overlapping passes never fight over a
      // row.
      const result = await db
        .prepare(
          `UPDATE ramp_webhook_events
             SET status = 'pending', attempts = 0, parked_app_revision = NULL,
                 updated_at = sdp_iso_now()
           WHERE id IN (
             SELECT id FROM ramp_webhook_events
              WHERE status = 'failed' AND NOT terminal AND parked_app_revision IS DISTINCT FROM ?
                AND provider = ANY(?::text[]) AND provider <> ALL(?::text[])
              ORDER BY created_at ASC
              LIMIT 100
              FOR UPDATE SKIP LOCKED
           )
           RETURNING *`
        )
        .bind(input.appRevision, KNOWN_PROVIDERS, [...input.excludedProviders])
        .all<Record<string, unknown>>();
      return result.results.map(mapRow);
    },
  };
}
