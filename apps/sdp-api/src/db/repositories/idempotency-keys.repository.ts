/**
 * The shared Idempotency-Key record (HOO-1918, migration 0126), written only
 * by `middleware/idempotency.ts`.
 *
 * A key is claimed before the handler runs and holds a lease. The claim token
 * names the request holding it; every later write is a compare-and-swap on that
 * token, so a request that outlived its lease cannot overwrite the request that
 * took the key over.
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
  fingerprint: string;
  leaseSeconds: number;
  retentionSeconds: number;
}

/** What a completed request answered, replayed as-is. */
export interface StoredIdempotentResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type IdempotencyKeyClaim =
  /**
   * This request holds the key. `fresh` is false when it took over an
   * `in_progress` row whose lease had expired, which an earlier attempt may
   * have partly executed, so releasing it must keep the row bound to its
   * fingerprint.
   */
  | { kind: "claimed"; fresh: boolean }
  | { kind: "completed"; response: StoredIdempotentResponse }
  /** The key was first used for a different request. */
  | { kind: "mismatch" }
  /** Another request holds a live lease on the key. */
  | { kind: "in_flight"; retryAfterSeconds: number };

export interface IdempotencyKeyRepository {
  claim(input: IdempotencyKeyClaimInput): Promise<IdempotencyKeyClaim>;
  /** Records the response. False when this request no longer holds the key. */
  complete(id: string, claimToken: string, response: StoredIdempotentResponse): Promise<boolean>;
  /** Deletes a fresh claim that nothing ran under. */
  discard(id: string, claimToken: string): Promise<void>;
  /** Ends the lease now, keeping the row bound to its fingerprint. */
  unlock(id: string, claimToken: string): Promise<void>;
  /** Deletes up to `limit` expired rows. Returns how many went. */
  pruneExpired(limit: number): Promise<number>;
}

const existingRowSchema = z.object({
  fingerprint: z.string(),
  status: z.enum(["in_progress", "completed"]),
  response_status: z.number().nullable(),
  response_headers: z.record(z.string(), z.string()).nullable(),
  response_body: z.string().nullable(),
  retry_after_seconds: z.coerce.number().nullable(),
});

const SCOPE_MATCH = `organization_id = ? AND project_id IS NOT DISTINCT FROM ?
  AND operation = ? AND idempotency_key = ?`;

export function createPostgresIdempotencyKeyRepository(
  db: RepositoryDbClient
): IdempotencyKeyRepository {
  return {
    async claim(input) {
      const scope = [
        input.organizationId,
        input.projectId,
        input.operation,
        input.idempotencyKey,
      ] as const;

      // A new key, or one whose row expired and was not pruned yet: either way
      // nothing it recorded still counts, so the row starts over.
      const inserted = await db
        .prepare(
          `INSERT INTO idempotency_keys
             (id, organization_id, project_id, operation, idempotency_key, fingerprint,
              status, claim_token, locked_until, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, 'in_progress', ?,
                   now() + make_interval(secs => ?), now() + make_interval(secs => ?))
           ON CONFLICT ON CONSTRAINT idempotency_keys_scope_key DO UPDATE
             SET id = EXCLUDED.id,
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
          ...scope,
          input.fingerprint,
          input.claimToken,
          input.leaseSeconds,
          input.retentionSeconds
        )
        .first<{ id: string }>();
      if (inserted !== null) {
        return { kind: "claimed", fresh: true };
      }

      // An earlier attempt with this request crashed or failed with a 5xx and
      // its lease is over: this request takes the row over and runs again.
      const takenOver = await db
        .prepare(
          `UPDATE idempotency_keys
              SET id = ?, claim_token = ?, locked_until = now() + make_interval(secs => ?),
                  updated_at = sdp_iso_now()
            WHERE ${SCOPE_MATCH}
              AND status = 'in_progress' AND fingerprint = ?
              AND locked_until <= now() AND expires_at > now()
            RETURNING id`
        )
        .bind(input.id, input.claimToken, input.leaseSeconds, ...scope, input.fingerprint)
        .first<{ id: string }>();
      if (takenOver !== null) {
        return { kind: "claimed", fresh: false };
      }

      const existing = await db
        .prepare(
          `SELECT fingerprint, status, response_status, response_headers, response_body,
                  CEIL(EXTRACT(EPOCH FROM (locked_until - now())))::int AS retry_after_seconds
             FROM idempotency_keys
            WHERE ${SCOPE_MATCH}`
        )
        .bind(...scope)
        .first<Record<string, unknown>>();
      if (existing === null) {
        // Pruned between the statements above. Rare; the client retries.
        return { kind: "in_flight", retryAfterSeconds: 1 };
      }
      const row = existingRowSchema.parse(existing);
      if (row.fingerprint !== input.fingerprint) {
        return { kind: "mismatch" };
      }
      if (row.status === "completed" && row.response_status !== null) {
        return {
          kind: "completed",
          response: {
            status: row.response_status,
            headers: row.response_headers ?? {},
            body: row.response_body ?? "",
          },
        };
      }
      return { kind: "in_flight", retryAfterSeconds: Math.max(1, row.retry_after_seconds ?? 1) };
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
