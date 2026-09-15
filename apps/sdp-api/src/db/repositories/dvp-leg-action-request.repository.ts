/**
 * The Idempotency-Key record for funding or reclaiming one DvP leg.
 *
 * Owned by the caller's organization, so it stays inside ordinary tenant
 * isolation even when the trade belongs to somebody else.
 */

import { type Signature, signature } from "@solana/kit";
import { z } from "zod";
import type { RepositoryDbClient } from "./base";

const dvpLegActionRequestRowSchema = z.object({
  id: z.string(),
  fingerprint: z.string(),
  side: z.enum(["a", "b"]),
  status: z.enum(["pending", "sent"]),
  signature: z.string().nullable(),
  amount: z.string().nullable(),
  expiry_height: z.string().nullable(),
  updated_at: z.string(),
});

/** The transaction a request is about to broadcast, written before it goes out. */
export interface DvpLegActionAttempt {
  signature: Signature;
  /** Base units, as the response reports them. */
  amount: string;
  /** Past this block height the transaction can no longer land. */
  expiryHeight: string;
}

export type DvpLegActionRequest =
  | {
      id: string;
      fingerprint: string;
      status: "pending";
      side: "a" | "b";
      /** Null until the request signed a transaction; nothing was broadcast before that. */
      attempt: DvpLegActionAttempt | null;
      updatedAt: string;
    }
  | {
      id: string;
      fingerprint: string;
      status: "sent";
      side: "a" | "b";
      attempt: DvpLegActionAttempt;
      updatedAt: string;
    };

export interface DvpLegActionRequestInsert {
  id: string;
  organizationId: string;
  projectId: string;
  idempotencyKey: string;
  fingerprint: string;
  action: "fund" | "reclaim";
  tradeId: string;
  side: "a" | "b";
}

export interface DvpLegActionRequestRepository {
  /**
   * Takes the key for a new request, or returns the row that already holds it.
   *
   * The insert is the race: the unique (project, key) index lets exactly one
   * caller write `pending`, and every other caller reads what it wrote.
   * `existing` is null only when the holder released the key between the insert
   * and the read; the caller refuses and the client retries.
   */
  reserve(
    input: DvpLegActionRequestInsert
  ): Promise<{ reserved: true } | { reserved: false; existing: DvpLegActionRequest | null }>;
  /**
   * Writes the transaction onto the pending row before it is broadcast.
   *
   * @returns False when the row is no longer this request's to write.
   */
  recordAttempt(id: string, attempt: DvpLegActionAttempt): Promise<boolean>;
  /** Marks the recorded attempt as the answer, so a retry replays it. */
  markSent(id: string): Promise<boolean>;
  /**
   * Frees a pending key whose request was refused before sending anything, so
   * the same key can be tried again. Never touches a `sent` row.
   */
  release(id: string): Promise<void>;
  /**
   * Hands a pending row to a new request, clearing any attempt on it.
   *
   * Guarded on the attempt the caller resolved (null for none) and, for a row
   * with no attempt, on its age, so a live request is never taken over.
   *
   * @returns Whether this call now holds the row.
   */
  retake(id: string, expectedSignature: Signature | null, staleBefore: string): Promise<boolean>;
}

function toDvpLegActionRequest(row: Record<string, unknown>): DvpLegActionRequest {
  const parsed = dvpLegActionRequestRowSchema.parse(row);
  const attempt =
    parsed.signature === null || parsed.amount === null || parsed.expiry_height === null
      ? null
      : {
          signature: signature(parsed.signature),
          amount: parsed.amount,
          expiryHeight: parsed.expiry_height,
        };
  if (parsed.status === "pending") {
    return {
      id: parsed.id,
      fingerprint: parsed.fingerprint,
      status: "pending",
      side: parsed.side,
      attempt,
      updatedAt: parsed.updated_at,
    };
  }
  // The table's CHECK makes a sent row without its attempt impossible; one that
  // somehow has none is not a result to replay.
  if (attempt === null) {
    throw new Error(`dvp_leg_action_requests ${parsed.id} is sent without its result`);
  }
  return {
    id: parsed.id,
    fingerprint: parsed.fingerprint,
    status: "sent",
    side: parsed.side,
    attempt,
    updatedAt: parsed.updated_at,
  };
}

export function createPostgresDvpLegActionRequestRepository(
  db: RepositoryDbClient
): DvpLegActionRequestRepository {
  return {
    async reserve(input) {
      const inserted = await db
        .prepare(
          `INSERT INTO dvp_leg_action_requests
             (id, organization_id, project_id, idempotency_key, fingerprint, action, trade_id, side, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
           ON CONFLICT (project_id, idempotency_key) DO NOTHING
           RETURNING id`
        )
        .bind(
          input.id,
          input.organizationId,
          input.projectId,
          input.idempotencyKey,
          input.fingerprint,
          input.action,
          input.tradeId,
          input.side
        )
        .first<{ id: string }>();
      if (inserted !== null) {
        return { reserved: true };
      }
      const existing = await db
        .prepare(
          `SELECT id, fingerprint, side, status, signature, amount, expiry_height, updated_at
             FROM dvp_leg_action_requests
            WHERE project_id = ? AND idempotency_key = ?`
        )
        .bind(input.projectId, input.idempotencyKey)
        .first<Record<string, unknown>>();
      if (existing === null) {
        return { reserved: false, existing: null };
      }
      return { reserved: false, existing: toDvpLegActionRequest(existing) };
    },

    async recordAttempt(id, attempt) {
      const row = await db
        .prepare(
          `UPDATE dvp_leg_action_requests
              SET signature = ?, amount = ?, expiry_height = ?, updated_at = sdp_iso_now()
            WHERE id = ? AND status = 'pending'
            RETURNING id`
        )
        .bind(attempt.signature, attempt.amount, attempt.expiryHeight, id)
        .first<{ id: string }>();
      return row !== null;
    },

    async markSent(id) {
      const row = await db
        .prepare(
          `UPDATE dvp_leg_action_requests
              SET status = 'sent', updated_at = sdp_iso_now()
            WHERE id = ? AND status = 'pending' AND signature IS NOT NULL
            RETURNING id`
        )
        .bind(id)
        .first<{ id: string }>();
      return row !== null;
    },

    async release(id) {
      await db
        .prepare(`DELETE FROM dvp_leg_action_requests WHERE id = ? AND status = 'pending'`)
        .bind(id)
        .run();
    },

    async retake(id, expectedSignature, staleBefore) {
      const row = await db
        .prepare(
          `UPDATE dvp_leg_action_requests
              SET signature = NULL, amount = NULL, expiry_height = NULL, updated_at = sdp_iso_now()
            WHERE id = ? AND status = 'pending'
              AND signature IS NOT DISTINCT FROM ?
              AND (signature IS NOT NULL OR updated_at < ?)
            RETURNING id`
        )
        .bind(id, expectedSignature, staleBefore)
        .first<{ id: string }>();
      return row !== null;
    },
  };
}
