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
  action: z.enum(["fund", "reclaim"]),
  trade_id: z.string(),
  side: z.enum(["a", "b"]),
  status: z.enum(["pending", "sent"]),
  signature: z.string().nullable(),
  amount: z.string().nullable(),
  updated_at: z.string(),
});

export type DvpLegActionRequest =
  | {
      id: string;
      fingerprint: string;
      status: "pending";
      updatedAt: string;
    }
  | {
      id: string;
      fingerprint: string;
      status: "sent";
      action: "fund" | "reclaim";
      tradeId: string;
      side: "a" | "b";
      signature: Signature;
      amount: string;
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
  /** Records what the action returned, so a retry is answered from it. */
  markSent(id: string, result: { signature: Signature; amount: string }): Promise<void>;
  /**
   * Frees a pending key whose request ended without sending anything, so the
   * same key can be tried again. Never touches a `sent` row.
   */
  release(id: string): Promise<void>;
  /**
   * Hands a pending row abandoned before `staleBefore` to a new request.
   *
   * @returns Whether this call now holds it. False when it was sent, released or
   *   retaken in the meantime.
   */
  retakeAbandoned(id: string, staleBefore: string): Promise<boolean>;
}

function toDvpLegActionRequest(row: Record<string, unknown>): DvpLegActionRequest {
  const parsed = dvpLegActionRequestRowSchema.parse(row);
  if (parsed.status === "pending") {
    return {
      id: parsed.id,
      fingerprint: parsed.fingerprint,
      status: "pending",
      updatedAt: parsed.updated_at,
    };
  }
  // The table's CHECK makes a sent row without both impossible; a row that
  // somehow has neither is not a result to replay.
  if (parsed.signature === null || parsed.amount === null) {
    throw new Error(`dvp_leg_action_requests ${parsed.id} is sent without its result`);
  }
  return {
    id: parsed.id,
    fingerprint: parsed.fingerprint,
    status: "sent",
    action: parsed.action,
    tradeId: parsed.trade_id,
    side: parsed.side,
    signature: signature(parsed.signature),
    amount: parsed.amount,
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
          `SELECT id, fingerprint, action, trade_id, side, status, signature, amount, updated_at
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

    async markSent(id, result) {
      await db
        .prepare(
          `UPDATE dvp_leg_action_requests
              SET status = 'sent', signature = ?, amount = ?, updated_at = sdp_iso_now()
            WHERE id = ? AND status = 'pending'`
        )
        .bind(result.signature, result.amount, id)
        .run();
    },

    async release(id) {
      await db
        .prepare(`DELETE FROM dvp_leg_action_requests WHERE id = ? AND status = 'pending'`)
        .bind(id)
        .run();
    },

    async retakeAbandoned(id, staleBefore) {
      const row = await db
        .prepare(
          `UPDATE dvp_leg_action_requests
              SET updated_at = sdp_iso_now()
            WHERE id = ? AND status = 'pending' AND updated_at < ?
            RETURNING id`
        )
        .bind(id, staleBefore)
        .first<{ id: string }>();
      return row !== null;
    },
  };
}
