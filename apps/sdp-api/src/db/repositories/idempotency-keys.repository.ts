/**
 * The shared Idempotency-Key record (HOO-1918, migration 0133), written only
 * by `middleware/idempotency.ts`.
 *
 * A key is claimed before the handler runs and holds a lease that the request
 * renews while it runs. The claim token names the request holding it; every
 * later write is a compare-and-swap on that token, so a request that lost the
 * key cannot overwrite the request that took it over.
 */

import { z } from "zod";
import type { DatabaseClient as RepositoryDbClient } from "@/db/client";

/** The scope a key is unique within, plus the request it was first used for. */
export interface IdempotencyKeyClaimInput {
  id: string;
  claimToken: string;
  organizationId: string;
  projectId: string;
  operation: string;
  idempotencyKey: string;
  /** The credential (API key id or user id) making the request. */
  principal: string;
  fingerprint: string;
  /**
   * Whether a claim whose lease lapsed without being released (a crash, a
   * failed outcome write, a request past its renewal cap) may be taken over:
   * only where the route answers the retry from its own domain row. Otherwise
   * the earlier attempt may have run and nothing records it, so the claim
   * answers `outcome_unknown` until it expires.
   */
  takeOverLapsed: boolean;
  /**
   * How long after it was claimed a request may still be running although its
   * lease lapsed (its renewals failing through a database blip): the renewal
   * cap plus the lease. Until then a lapsed, unreleased claim answers
   * `in_flight`, never a takeover or `outcome_unknown`.
   */
  presumedLiveSeconds: number;
  leaseSeconds: number;
  retentionSeconds: number;
}

/** What a completed request answered, replayed as-is. */
export const storedIdempotentResponseSchema = z.object({
  status: z.number().int(),
  headers: z.record(z.string(), z.string()),
  /** Null for a response without a body (204, 205, 304). */
  body: z.string().nullable(),
});

export type StoredIdempotentResponse = z.infer<typeof storedIdempotentResponseSchema>;

/** The result of claiming a key. */
export const idempotencyKeyClaimSchema = z.discriminatedUnion("kind", [
  /**
   * This request holds the key. `fresh` is false when it took over an
   * `in_progress` row whose lease had ended, which an earlier attempt may have
   * partly executed, so releasing it must keep the row bound to its
   * fingerprint.
   */
  z.object({
    kind: z.literal("claimed"),
    fresh: z.boolean(),
    /**
     * The key's earlier row had expired while still `in_progress` with a lease
     * that lapsed rather than was released: a request that crashed before
     * recording an outcome. The new claim replaces it; callers alert.
     */
    replacedUnfinished: z.boolean(),
  }),
  z.object({ kind: z.literal("completed"), response: storedIdempotentResponseSchema }),
  /** The key was first used for a different request or by another credential. */
  z.object({ kind: z.literal("mismatch") }),
  /** Another request holds a live lease on the key. */
  z.object({ kind: z.literal("in_flight"), retryAfterSeconds: z.number().int() }),
  /**
   * The key's request lapsed without recording an outcome or being released,
   * and this route may not take it over: whether it ran is unknown.
   */
  z.object({ kind: z.literal("outcome_unknown") }),
]);

export type IdempotencyKeyClaim = z.infer<typeof idempotencyKeyClaimSchema>;

export interface IdempotencyKeyRepository {
  claim(input: IdempotencyKeyClaimInput): Promise<IdempotencyKeyClaim>;
  /** Extends the lease. False when this request no longer holds the key. */
  renew(id: string, claimToken: string, leaseSeconds: number): Promise<boolean>;
  /** Records the response. False when this request no longer holds the key. */
  complete(id: string, claimToken: string, response: StoredIdempotentResponse): Promise<boolean>;
  /** Deletes a fresh claim that nothing ran under. */
  discard(id: string, claimToken: string): Promise<void>;
  /**
   * Ends the lease now and marks it released, keeping the row bound to its
   * fingerprint: a takeover can still claim it, and it is not alerted on.
   */
  unlock(id: string, claimToken: string): Promise<void>;
  /**
   * Deletes up to `limit` expired rows. Returns how many went, and how many of
   * those were left by a crash (still `in_progress`, lease lapsed, never
   * released), which callers alert on.
   */
  pruneExpired(limit: number): Promise<{ deleted: number; unfinished: number }>;
}

const existingRowSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("in_progress"),
    principal: z.string(),
    fingerprint: z.string(),
    retry_after_seconds: z.number().int(),
    lapsed: z.boolean(),
    released: z.boolean(),
    presumed_live: z.boolean(),
    presumed_live_seconds: z.number().int(),
  }),
  z.object({
    status: z.literal("completed"),
    principal: z.string(),
    fingerprint: z.string(),
    response_status: z.number().int().min(100).max(599),
    response_headers: z.record(z.string(), z.string()),
    response_body: z.string().nullable(),
  }),
]);

/**
 * The longest Retry-After for a lapsed claim that may still be running: the
 * window can be many minutes, and a retry a minute later learns more.
 */
const MAX_PRESUMED_LIVE_RETRY_AFTER = 60;

/** The scope predicate, matching the scope unique constraint. */
function scopeMatch(input: IdempotencyKeyClaimInput): { sql: string; params: unknown[] } {
  return {
    sql: "organization_id = ? AND project_id = ? AND operation = ? AND idempotency_key = ?",
    params: [input.organizationId, input.projectId, input.operation, input.idempotencyKey],
  };
}

export function createPostgresIdempotencyKeyRepository(
  db: RepositoryDbClient
): IdempotencyKeyRepository {
  async function tryClaim(input: IdempotencyKeyClaimInput): Promise<IdempotencyKeyClaim | null> {
    // A new key, or one whose row expired and was not pruned yet: either way
    // nothing it recorded still counts, so the row starts over.
    const scope = scopeMatch(input);
    // A new key, or one whose row expired and was not pruned yet: either way
    // nothing it recorded still counts, so the row starts over. The CTE reads
    // the expired row's status from before the statement, to report an
    // unfinished request being replaced.
    const inserted = await db
      .prepare(
        `WITH expired AS (
           SELECT status, released FROM idempotency_keys WHERE ${scope.sql} AND expires_at <= now()
         )
         INSERT INTO idempotency_keys
           (id, organization_id, project_id, operation, idempotency_key, principal, fingerprint,
            status, claim_token, locked_until, claimed_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'in_progress', ?,
                 now() + make_interval(secs => ?), now(), now() + make_interval(secs => ?))
         ON CONFLICT ON CONSTRAINT idempotency_keys_scope_key DO UPDATE
           SET id = EXCLUDED.id,
               principal = EXCLUDED.principal,
               fingerprint = EXCLUDED.fingerprint,
               status = 'in_progress',
               claim_token = EXCLUDED.claim_token,
               locked_until = EXCLUDED.locked_until,
               claimed_at = EXCLUDED.claimed_at,
               released = false,
               response_status = NULL,
               response_headers = NULL,
               response_body = NULL,
               created_at = sdp_iso_now(),
               updated_at = sdp_iso_now(),
               expires_at = EXCLUDED.expires_at
           WHERE idempotency_keys.expires_at <= now()
         RETURNING id,
           (SELECT status = 'in_progress' AND NOT released FROM expired) AS replaced_unfinished`
      )
      .bind(
        ...scope.params,
        input.id,
        input.organizationId,
        input.projectId,
        input.operation,
        input.idempotencyKey,
        input.principal,
        input.fingerprint,
        input.claimToken,
        input.leaseSeconds,
        input.retentionSeconds
      )
      .first<{ id: string; replaced_unfinished: boolean | null }>();
    if (inserted !== null) {
      return {
        kind: "claimed",
        fresh: true,
        replacedUnfinished: inserted.replaced_unfinished === true,
      };
    }

    // An earlier attempt with this request failed (released) or, on a route
    // that allows it, crashed (its lease lapsed and it is past the time it
    // could still be running): this request takes the row over and runs again.
    const takenOver = await db
      .prepare(
        `UPDATE idempotency_keys
            SET id = ?, claim_token = ?, locked_until = now() + make_interval(secs => ?),
                claimed_at = now(), released = false, updated_at = sdp_iso_now()
          WHERE ${scope.sql}
            AND status = 'in_progress' AND principal = ? AND fingerprint = ?
            AND locked_until <= now() AND expires_at > now()
            AND (released OR (?::boolean AND claimed_at + make_interval(secs => ?) <= now()))
          RETURNING id`
      )
      .bind(
        input.id,
        input.claimToken,
        input.leaseSeconds,
        ...scope.params,
        input.principal,
        input.fingerprint,
        input.takeOverLapsed,
        input.presumedLiveSeconds
      )
      .first<{ id: string }>();
    if (takenOver !== null) {
      return { kind: "claimed", fresh: false, replacedUnfinished: false };
    }

    const existing = await db
      .prepare(
        `SELECT principal, fingerprint, status, response_status, response_headers, response_body,
                GREATEST(1, CEIL(EXTRACT(EPOCH FROM (locked_until - now()))))::int
                  AS retry_after_seconds,
                locked_until <= now() AS lapsed, released,
                claimed_at + make_interval(secs => ?) > now() AS presumed_live,
                GREATEST(1, CEIL(EXTRACT(EPOCH FROM
                  (claimed_at + make_interval(secs => ?) - now()))))::int AS presumed_live_seconds
           FROM idempotency_keys
          WHERE ${scope.sql} AND expires_at > now()`
      )
      .bind(input.presumedLiveSeconds, input.presumedLiveSeconds, ...scope.params)
      .first<Record<string, unknown>>();
    if (existing === null) {
      // Pruned or expired between the statements above.
      return null;
    }
    const row = existingRowSchema.parse(existing);
    if (row.principal !== input.principal || row.fingerprint !== input.fingerprint) {
      return { kind: "mismatch" };
    }
    if (row.status === "completed") {
      return {
        kind: "completed",
        response: {
          status: row.response_status,
          headers: row.response_headers,
          body: row.response_body,
        },
      };
    }
    if (row.lapsed) {
      if (row.released) {
        // Released after the takeover above saw it live: claim again.
        return null;
      }
      if (row.presumed_live) {
        // Its renewals may only be failing: the request can still be running.
        return {
          kind: "in_flight",
          retryAfterSeconds: Math.min(row.presumed_live_seconds, MAX_PRESUMED_LIVE_RETRY_AFTER),
        };
      }
      if (input.takeOverLapsed) {
        // Its window ended after the takeover above ran: claim again.
        return null;
      }
      return { kind: "outcome_unknown" };
    }
    return { kind: "in_flight", retryAfterSeconds: row.retry_after_seconds };
  }

  return {
    async claim(input) {
      // One retry covers a row that vanished, or whose lease ran out, mid-claim;
      // the second attempt's insert or takeover then succeeds.
      const claim = (await tryClaim(input)) ?? (await tryClaim(input));
      if (claim === null) {
        throw new Error("idempotency key changed twice during one claim");
      }
      return claim;
    },

    async renew(id, claimToken, leaseSeconds) {
      const row = await db
        .prepare(
          `UPDATE idempotency_keys
              SET locked_until = now() + make_interval(secs => ?), updated_at = sdp_iso_now()
            WHERE id = ? AND claim_token = ? AND status = 'in_progress'
            RETURNING id`
        )
        .bind(leaseSeconds, id, claimToken)
        .first<{ id: string }>();
      return row !== null;
    },

    async complete(id, claimToken, response) {
      const row = await db
        .prepare(
          `UPDATE idempotency_keys
              SET status = 'completed', claim_token = NULL, locked_until = NULL,
                  response_status = ?, response_headers = ?::jsonb, response_body = ?,
                  updated_at = sdp_iso_now()
            WHERE id = ? AND claim_token = ? AND status = 'in_progress'
            RETURNING id`
        )
        .bind(response.status, JSON.stringify(response.headers), response.body, id, claimToken)
        .first<{ id: string }>();
      return row !== null;
    },

    async discard(id, claimToken) {
      await db
        .prepare(
          `DELETE FROM idempotency_keys
            WHERE id = ? AND claim_token = ? AND status = 'in_progress'`
        )
        .bind(id, claimToken)
        .run();
    },

    async unlock(id, claimToken) {
      await db
        .prepare(
          `UPDATE idempotency_keys
              SET locked_until = now(), released = true, updated_at = sdp_iso_now()
            WHERE id = ? AND claim_token = ? AND status = 'in_progress'`
        )
        .bind(id, claimToken)
        .run();
    },

    async pruneExpired(limit) {
      const row = await db
        .prepare(
          `WITH doomed AS (
             SELECT id FROM idempotency_keys
              WHERE expires_at <= now()
              ORDER BY expires_at
              LIMIT ?
              FOR UPDATE SKIP LOCKED
           ), deleted AS (
             DELETE FROM idempotency_keys WHERE id IN (SELECT id FROM doomed)
               RETURNING status, released
           )
           SELECT count(*)::int AS deleted,
                  count(*) FILTER (WHERE status = 'in_progress' AND NOT released)::int AS unfinished
             FROM deleted`
        )
        .bind(limit)
        .first<{ deleted: number; unfinished: number }>();
      if (row === null) {
        // The aggregate returns one row even when nothing was deleted.
        throw new Error("idempotency key prune returned no row");
      }
      return { deleted: row.deleted, unfinished: row.unfinished };
    },
  };
}
