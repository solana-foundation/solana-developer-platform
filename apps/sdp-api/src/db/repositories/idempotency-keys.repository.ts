/**
 * The shared Idempotency-Key record (HOO-1918, migration 0127), written only
 * by `middleware/idempotency.ts`.
 *
 * A key is claimed before the handler runs and holds a lease that the request
 * renews while it runs. The claim token names the request holding it; every
 * later write is a compare-and-swap on that token, so a request that lost the
 * key cannot overwrite the request that took it over.
 */

import { z } from "zod";
import type { RepositoryDbClient } from "./base";

/** The scope a key is unique within, plus the request it was first used for. */
export interface IdempotencyKeyClaimInput {
  id: string;
  claimToken: string;
  organizationId: string;
  projectId: string | null;
  operation: string;
  idempotencyKey: string;
  /** The credential making the request and its access, as canonical JSON. */
  principal: string;
  fingerprint: string;
  leaseSeconds: number;
  retentionSeconds: number;
}

/** What a completed request answered, replayed as-is. */
export interface StoredIdempotentResponse {
  status: number;
  headers: Record<string, string>;
  /** Null for a response without a body (204, 205, 304). */
  body: string | null;
}

export type IdempotencyKeyClaim =
  /**
   * This request holds the key. `fresh` is false when it took over an
   * `in_progress` row whose lease had ended, which an earlier attempt may have
   * partly executed, so releasing it must keep the row bound to its
   * fingerprint.
   */
  | { kind: "claimed"; fresh: boolean }
  | { kind: "completed"; response: StoredIdempotentResponse }
  /** The key was first used for a different request or by another credential. */
  | { kind: "mismatch" }
  /** Another request holds a live lease on the key. */
  | { kind: "in_flight"; retryAfterSeconds: number };

export interface IdempotencyKeyRepository {
  claim(input: IdempotencyKeyClaimInput): Promise<IdempotencyKeyClaim>;
  /** Extends the lease. False when this request no longer holds the key. */
  renew(id: string, claimToken: string, leaseSeconds: number): Promise<boolean>;
  /** Records the response. False when this request no longer holds the key. */
  complete(id: string, claimToken: string, response: StoredIdempotentResponse): Promise<boolean>;
  /** Deletes a fresh claim that nothing ran under. */
  discard(id: string, claimToken: string): Promise<void>;
  /** Ends the lease now, keeping the row bound to its fingerprint. */
  unlock(id: string, claimToken: string): Promise<void>;
  /** Deletes up to `limit` expired rows. Returns how many went. */
  pruneExpired(limit: number): Promise<number>;
}

const existingRowSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("in_progress"),
    principal: z.string(),
    fingerprint: z.string(),
    retry_after_seconds: z.number().int(),
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
 * The scope predicate. A null project is matched with IS NULL rather than
 * IS NOT DISTINCT FROM, so Postgres can use the scope index.
 */
function scopeMatch(input: IdempotencyKeyClaimInput): { sql: string; params: unknown[] } {
  const project = input.projectId === null ? "project_id IS NULL" : "project_id = ?";
  return {
    sql: `organization_id = ? AND ${project} AND operation = ? AND idempotency_key = ?`,
    params: [
      input.organizationId,
      ...(input.projectId === null ? [] : [input.projectId]),
      input.operation,
      input.idempotencyKey,
    ],
  };
}

export function createPostgresIdempotencyKeyRepository(
  db: RepositoryDbClient
): IdempotencyKeyRepository {
  async function tryClaim(input: IdempotencyKeyClaimInput): Promise<IdempotencyKeyClaim | null> {
    // A new key, or one whose row expired and was not pruned yet: either way
    // nothing it recorded still counts, so the row starts over.
    const inserted = await db
      .prepare(
        `INSERT INTO idempotency_keys
           (id, organization_id, project_id, operation, idempotency_key, principal, fingerprint,
            status, claim_token, locked_until, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'in_progress', ?,
                 now() + make_interval(secs => ?), now() + make_interval(secs => ?))
         ON CONFLICT ON CONSTRAINT idempotency_keys_scope_key DO UPDATE
           SET id = EXCLUDED.id,
               principal = EXCLUDED.principal,
               fingerprint = EXCLUDED.fingerprint,
               status = 'in_progress',
               claim_token = EXCLUDED.claim_token,
               locked_until = EXCLUDED.locked_until,
               response_status = NULL,
               response_headers = NULL,
               response_body = NULL,
               created_at = sdp_iso_now(),
               updated_at = sdp_iso_now(),
               expires_at = EXCLUDED.expires_at
           WHERE idempotency_keys.expires_at <= now()
         RETURNING id`
      )
      .bind(
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
      .first<{ id: string }>();
    if (inserted !== null) {
      return { kind: "claimed", fresh: true };
    }

    const scope = scopeMatch(input);
    // An earlier attempt with this request crashed or failed and its lease is
    // over: this request takes the row over and runs again.
    const takenOver = await db
      .prepare(
        `UPDATE idempotency_keys
            SET id = ?, claim_token = ?, locked_until = now() + make_interval(secs => ?),
                updated_at = sdp_iso_now()
          WHERE ${scope.sql}
            AND status = 'in_progress' AND principal = ? AND fingerprint = ?
            AND locked_until <= now() AND expires_at > now()
          RETURNING id`
      )
      .bind(
        input.id,
        input.claimToken,
        input.leaseSeconds,
        ...scope.params,
        input.principal,
        input.fingerprint
      )
      .first<{ id: string }>();
    if (takenOver !== null) {
      return { kind: "claimed", fresh: false };
    }

    const existing = await db
      .prepare(
        `SELECT principal, fingerprint, status, response_status, response_headers, response_body,
                GREATEST(1, CEIL(EXTRACT(EPOCH FROM (locked_until - now()))))::int
                  AS retry_after_seconds
           FROM idempotency_keys
          WHERE ${scope.sql} AND expires_at > now()`
      )
      .bind(...scope.params)
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
    return { kind: "in_flight", retryAfterSeconds: row.retry_after_seconds };
  }

  return {
    async claim(input) {
      // One retry covers a row that vanished mid-claim; the second attempt's
      // insert then succeeds.
      const claim = (await tryClaim(input)) ?? (await tryClaim(input));
      if (claim === null) {
        throw new Error("idempotency key vanished twice during one claim");
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
              SET locked_until = now(), updated_at = sdp_iso_now()
            WHERE id = ? AND claim_token = ? AND status = 'in_progress'`
        )
        .bind(id, claimToken)
        .run();
    },

    async pruneExpired(limit) {
      return db
        .prepare(
          `DELETE FROM idempotency_keys
            WHERE id IN (
              SELECT id FROM idempotency_keys
               WHERE expires_at <= now()
               ORDER BY expires_at
               LIMIT ?
               FOR UPDATE SKIP LOCKED
            )`
        )
        .bind(limit)
        .run();
    },
  };
}
