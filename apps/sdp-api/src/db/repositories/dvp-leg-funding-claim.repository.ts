/**
 * The funding lock for a leg funded by somebody other than the trade's author.
 *
 * Same compare-and-swap discipline as the columns on `dvp_trades` that 0080
 * added, with two differences that are the whole point of the table: the lock
 * is keyed by (trade, side) so two parties funding opposite legs never contend,
 * and the row belongs to the organization doing the funding so it stays inside
 * ordinary tenant isolation.
 */

import { z } from "zod";
import type { RepositoryDbClient } from "./base";

const dvpLegFundingClaimRowSchema = z.object({
  trade_id: z.string(),
  side: z.enum(["a", "b"]),
  organization_id: z.string(),
  project_id: z.string(),
  custody_wallet_id: z.string(),
  signature: z.string(),
  expiry_height: z.string(),
  funding_tx: z.string().nullable(),
});

export interface DvpLegFundingClaim {
  tradeId: string;
  side: "a" | "b";
  organizationId: string;
  projectId: string;
  custodyWalletId: string;
  signature: string;
  expiryHeight: string;
  fundingTx: string | null;
}

export interface DvpLegFundingClaimInsert {
  tradeId: string;
  side: "a" | "b";
  organizationId: string;
  projectId: string;
  custodyWalletId: string;
  signature: string;
  expiryHeight: string;
}

export interface DvpLegFundingClaimRepository {
  /**
   * Takes the lock on one leg, atomically.
   *
   * False when another request already holds it. The insert is the lock: the
   * primary key on (trade_id, side) is what makes exactly one caller win, so
   * there is no read-then-write window to lose.
   */
  claim(input: DvpLegFundingClaimInsert): Promise<boolean>;
  /**
   * Releases a claim whose broadcast was definitively rejected.
   *
   * Matched on the signature as well as the leg, so a release can only ever
   * remove the claim the caller itself took. Without that, a slow request could
   * release a newer claim taken after its own had already been swept.
   */
  release(tradeId: string, side: "a" | "b", signature: string): Promise<void>;
  /** Records the transfer once it is on the wire, so it outlives the claim. */
  recordFundingTx(tradeId: string, side: "a" | "b", signature: string): Promise<void>;
  /** Every claim on a trade, for rendering who has paid and who has not. */
  listForTrade(tradeId: string): Promise<DvpLegFundingClaim[]>;
  /**
   * Releases claims whose signed transaction can no longer be accepted.
   *
   * A claim is deliberately KEPT through an ambiguous broadcast failure,
   * because the transfer may still land and releasing it would invite a second
   * one on top. Past the last-valid height it provably cannot land, and a claim
   * held beyond that makes the leg permanently unfundable with a hand-edit as
   * the only way out — which is what the columns on `dvp_trades` are swept for,
   * and what this table needs for exactly the same reason.
   *
   * Never touches a claim that was broadcast: `funding_tx` set means the row is
   * a receipt rather than a lock.
   */
  releaseExpired(blockHeight: bigint): Promise<number>;
  /**
   * Lists broadcast claims whose signed transaction can no longer be accepted.
   *
   * `releaseExpired` deliberately never touches a row with `funding_tx` set:
   * on the wire means possibly landed. Past the last-valid height only the
   * chain can say which, so resolution belongs to the reconciler's RPC read,
   * never to the sweep.
   */
  listExpiredBroadcast(blockHeight: bigint): Promise<DvpLegFundingClaim[]>;
  /**
   * Deletes one broadcast claim whose transfer the chain confirmed never landed.
   *
   * Guarded on the signature AND `funding_tx IS NOT NULL`, so the reconciler
   * can only ever remove the exact row it checked on chain — never an
   * unbroadcast lock, which only `releaseExpired` may release.
   */
  deleteBroadcastClaim(tradeId: string, side: "a" | "b", signature: string): Promise<void>;
}

function toDvpLegFundingClaim(row: Record<string, unknown>): DvpLegFundingClaim {
  const parsed = dvpLegFundingClaimRowSchema.parse(row);
  return {
    tradeId: parsed.trade_id,
    side: parsed.side,
    organizationId: parsed.organization_id,
    projectId: parsed.project_id,
    custodyWalletId: parsed.custody_wallet_id,
    signature: parsed.signature,
    expiryHeight: parsed.expiry_height,
    fundingTx: parsed.funding_tx,
  };
}

export function createPostgresDvpLegFundingClaimRepository(
  db: RepositoryDbClient
): DvpLegFundingClaimRepository {
  return {
    async claim(input) {
      // ON CONFLICT DO NOTHING rather than an upsert: a conflict means somebody
      // else holds this leg, and overwriting their claim is exactly the
      // double-broadcast this table exists to prevent.
      const result = await db
        .prepare(
          `INSERT INTO dvp_leg_funding_claims
             (trade_id, side, organization_id, project_id, custody_wallet_id, signature, expiry_height)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (trade_id, side) DO NOTHING
           RETURNING trade_id`
        )
        .bind(
          input.tradeId,
          input.side,
          input.organizationId,
          input.projectId,
          input.custodyWalletId,
          input.signature,
          input.expiryHeight
        )
        .first<{ trade_id: string }>();
      return result !== null;
    },

    async release(tradeId, side, signature) {
      // Only an unbroadcast claim. Once `funding_tx` is set the transfer is on
      // the wire and the claim is a receipt, not a lock.
      await db
        .prepare(
          `DELETE FROM dvp_leg_funding_claims
            WHERE trade_id = ? AND side = ? AND signature = ? AND funding_tx IS NULL`
        )
        .bind(tradeId, side, signature)
        .run();
    },

    async recordFundingTx(tradeId, side, signature) {
      await db
        .prepare(
          `UPDATE dvp_leg_funding_claims
              SET funding_tx = ?, updated_at = sdp_iso_now()
            WHERE trade_id = ? AND side = ? AND signature = ?`
        )
        .bind(signature, tradeId, side, signature)
        .run();
    },

    async releaseExpired(blockHeight) {
      const result = await db
        .prepare(
          `DELETE FROM dvp_leg_funding_claims
            WHERE funding_tx IS NULL
              AND CAST(expiry_height AS NUMERIC) < ?
            RETURNING trade_id`
        )
        .bind(blockHeight.toString())
        .all<{ trade_id: string }>();
      return result.results.length;
    },

    async listForTrade(tradeId) {
      const result = await db
        .prepare(
          `SELECT trade_id, side, organization_id, project_id, custody_wallet_id,
                  signature, expiry_height, funding_tx
             FROM dvp_leg_funding_claims
            WHERE trade_id = ?`
        )
        .bind(tradeId)
        .all<Record<string, unknown>>();
      return result.results.map(toDvpLegFundingClaim);
    },

    async listExpiredBroadcast(blockHeight) {
      // Open trades only: a closed trade's leg can never be funded again, so
      // its claims are history — without this bound every landed receipt would
      // be re-checked on chain every tick forever.
      const result = await db
        .prepare(
          `SELECT c.trade_id, c.side, c.organization_id, c.project_id, c.custody_wallet_id,
                  c.signature, c.expiry_height, c.funding_tx
             FROM dvp_leg_funding_claims c
             JOIN dvp_trades t ON t.id = c.trade_id
            WHERE c.funding_tx IS NOT NULL
              AND CAST(c.expiry_height AS NUMERIC) < ?
              AND t.status IN ('created', 'partially_funded', 'funded')`
        )
        .bind(blockHeight.toString())
        .all<Record<string, unknown>>();
      return result.results.map(toDvpLegFundingClaim);
    },

    async deleteBroadcastClaim(tradeId, side, signature) {
      // `funding_tx IS NOT NULL` keeps this from ever releasing an unbroadcast
      // lock: the caller decided on chain that THIS signature never landed,
      // and an unbroadcast claim was never checked against the chain at all.
      await db
        .prepare(
          `DELETE FROM dvp_leg_funding_claims
            WHERE trade_id = ? AND side = ? AND signature = ? AND funding_tx IS NOT NULL`
        )
        .bind(tradeId, side, signature)
        .run();
    },
  };
}
