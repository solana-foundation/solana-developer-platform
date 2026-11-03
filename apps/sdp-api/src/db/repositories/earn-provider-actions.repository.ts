import { SDP_ENVIRONMENTS } from "@sdp/types/api-keys";
import {
  EARN_PROVIDER_ACTION_DUE_STATUSES,
  EARN_PROVIDER_ACTION_KINDS,
  EARN_PROVIDER_ACTION_STATUSES,
  EARN_PROVIDER_ACTION_TRANSITIONS,
  type EarnProviderActionStatus,
} from "@sdp/types/earn-provider-orders";
import { z } from "zod";
import type { DatabaseClient } from "@/db/client";
import { conflict } from "@/lib/errors";

const rowSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  environment: z.enum(SDP_ENVIRONMENTS),
  provider: z.string(),
  action: z.enum(EARN_PROVIDER_ACTION_KINDS),
  status: z.enum(EARN_PROVIDER_ACTION_STATUSES),
  parent_movement_id: z.string().nullable(),
  custody_wallet_id: z.string().nullable(),
  owner_address: z.string(),
  vault_address: z.string(),
  token_mint: z.string(),
  share_mint: z.string(),
  fee_payer: z.string().nullable(),
  request_id: z.string(),
  fingerprint: z.string(),
  unsigned_transaction: z.string().nullable(),
  signed_transaction: z.string().nullable(),
  signature: z.string().nullable(),
  last_valid_block_height: z.string().nullable(),
  delivery_signature: z.string().nullable(),
  error: z.string().nullable(),
  unknown_signature_observed_at: z.string().nullable(),
  lease_until: z.string(),
  next_check_at: z.string(),
  created_by: z.string().nullable(),
  initiated_by_key_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type EarnProviderActionRow = z.infer<typeof rowSchema>;
export type EarnProviderActionClaim = Pick<
  EarnProviderActionRow,
  | "organization_id"
  | "project_id"
  | "environment"
  | "provider"
  | "action"
  | "parent_movement_id"
  | "custody_wallet_id"
  | "owner_address"
  | "vault_address"
  | "token_mint"
  | "share_mint"
  | "fee_payer"
  | "request_id"
  | "fingerprint"
  | "created_by"
  | "initiated_by_key_id"
>;
type Scope = {
  organizationId: string;
  projectId: string;
  actionId: string;
  preparationLeaseUntil?: string;
};

/**
 * Whether the request claims a different payload than a pending row holds, on
 * every field the builder reads back from the row (`request_id`, `fingerprint`,
 * `created_by` and `initiated_by_key_id` identify the caller, so a recovery
 * under a new key is expected to differ there and never blocks).
 */
function claimsDiverge(row: EarnProviderActionRow, input: EarnProviderActionClaim): boolean {
  return (
    row.environment !== input.environment ||
    row.provider !== input.provider ||
    row.action !== input.action ||
    row.parent_movement_id !== input.parent_movement_id ||
    row.custody_wallet_id !== input.custody_wallet_id ||
    row.owner_address !== input.owner_address ||
    row.vault_address !== input.vault_address ||
    row.token_mint !== input.token_mint ||
    row.share_mint !== input.share_mint ||
    row.fee_payer !== input.fee_payer
  );
}

/**
 * The status predicate of the one-active-cancellation index (migration 0208:
 * `WHERE action='cancellation' AND status NOT IN ('failed','prepared')`). Every
 * query that reasons about the slot must match it exactly: a `prepared` build
 * holds no slot, so letting it answer a slot lookup hides the row whose
 * abandoned lease a new key must recover.
 */
const ONE_ACTIVE_CANCELLATION_SQL = "action='cancellation' AND status NOT IN ('failed','prepared')";

export function createEarnProviderActionsRepository(db: DatabaseClient) {
  return {
    async get(scope: Scope): Promise<EarnProviderActionRow | null> {
      const row = await db
        .prepare(
          "SELECT * FROM earn_provider_actions WHERE id=? AND organization_id=? AND project_id=?"
        )
        .bind(scope.actionId, scope.organizationId, scope.projectId)
        .first();
      return row === null ? null : rowSchema.parse(row);
    },
    async claim(
      input: EarnProviderActionClaim
    ): Promise<{ row: EarnProviderActionRow; owned: boolean }> {
      const columns = Object.keys(input);
      const row = await db
        .prepare(`INSERT INTO earn_provider_actions(id,status,lease_until,${columns.join(",")})
        VALUES (?,'preparing',?,${columns.map(() => "?").join(",")}) ON CONFLICT DO NOTHING RETURNING *`)
        .bind(
          `earn_provider_action_${crypto.randomUUID()}`,
          new Date(Date.now() + 120_000).toISOString(),
          ...Object.values(input)
        )
        .first();
      if (row !== null) return { row: rowSchema.parse(row), owned: true };
      const prior = await db
        .prepare(
          "SELECT * FROM earn_provider_actions WHERE organization_id=? AND project_id=? AND request_id=?"
        )
        .bind(input.organization_id, input.project_id, input.request_id)
        .first();
      if (prior === null && input.action === "cancellation") {
        const active = await db
          .prepare(
            `SELECT * FROM earn_provider_actions WHERE organization_id=? AND project_id=? AND parent_movement_id=? AND ${ONE_ACTIVE_CANCELLATION_SQL}`
          )
          .bind(input.organization_id, input.project_id, input.parent_movement_id)
          .first();
        if (active !== null) {
          const found = rowSchema.parse(active);
          // An abandoned claim still holds the parent's one-active-cancellation
          // slot: its creator crashed or refused before filing, so a NEW key
          // lands here with `request_id` unknown. Reclaim it under the same
          // guarded lease the request_id path uses, or losing the original key
          // (or rotating credentials) blocks cancellation forever.
          if (found.status === "preparing") {
            // Claimed fields are immutable: the builder reads the row, not
            // this request, so a recovery whose payload differs (a new fee
            // payer, a different wallet) must never own the old claim's bytes.
            if (claimsDiverge(found, input))
              throw conflict("Provider action claimed with a different request payload");
            const reclaimed = await db
              .prepare(
                "UPDATE earn_provider_actions SET lease_until=? WHERE id=? AND organization_id=? AND project_id=? AND status='preparing' AND lease_until<? RETURNING *"
              )
              .bind(
                new Date(Date.now() + 120_000).toISOString(),
                found.id,
                input.organization_id,
                input.project_id,
                new Date().toISOString()
              )
              .first();
            if (reclaimed !== null) return { row: rowSchema.parse(reclaimed), owned: true };
          }
          return { row: found, owned: false };
        }
      }
      const existing = rowSchema.parse(prior);
      if (existing.fingerprint !== input.fingerprint)
        throw conflict("Idempotency key already used with different request payload");
      const taken = await db
        .prepare(
          "UPDATE earn_provider_actions SET lease_until=? WHERE id=? AND organization_id=? AND project_id=? AND status='preparing' AND lease_until<? RETURNING *"
        )
        .bind(
          new Date(Date.now() + 120_000).toISOString(),
          existing.id,
          input.organization_id,
          input.project_id,
          new Date().toISOString()
        )
        .first();
      return taken === null
        ? { row: existing, owned: false }
        : { row: rowSchema.parse(taken), owned: true };
    },
    async advance(
      scope: Scope,
      from: EarnProviderActionStatus,
      to: EarnProviderActionStatus,
      values: Partial<
        Pick<
          EarnProviderActionRow,
          | "unsigned_transaction"
          | "signed_transaction"
          | "signature"
          | "last_valid_block_height"
          | "delivery_signature"
          | "fee_payer"
          | "error"
        >
      > = {}
    ): Promise<EarnProviderActionRow | null> {
      const allowed: readonly EarnProviderActionStatus[] = EARN_PROVIDER_ACTION_TRANSITIONS[from];
      if (!allowed.includes(to)) throw new Error("Invalid provider action transition");
      if (from === "preparing" && scope.preparationLeaseUntil === undefined)
        throw new Error("Preparation requires its ownership lease");
      const fields = Object.keys(values);
      const row = await db
        .prepare(
          `UPDATE earn_provider_actions SET status=?,updated_at=sdp_iso_now(),next_check_at=?${fields.length === 0 ? "" : `,${fields.map((f) => `${f}=?`).join(",")}`} WHERE id=? AND organization_id=? AND project_id=? AND status=?${from === "preparing" ? " AND lease_until=?" : ""} RETURNING *`
        )
        .bind(
          to,
          new Date(Date.now() + 120_000).toISOString(),
          ...Object.values(values),
          scope.actionId,
          scope.organizationId,
          scope.projectId,
          from,
          ...(from === "preparing" ? [scope.preparationLeaseUntil] : [])
        )
        .first();
      return row === null ? null : rowSchema.parse(row);
    },
    async releasePreparation(scope: Scope): Promise<void> {
      await db
        .prepare(
          "UPDATE earn_provider_actions SET lease_until=sdp_iso_now() WHERE id=? AND organization_id=? AND project_id=? AND status='preparing' AND lease_until=?"
        )
        .bind(scope.actionId, scope.organizationId, scope.projectId, scope.preparationLeaseUntil)
        .run();
    },
    async observeUnknownSignature(scope: Scope, status: EarnProviderActionStatus): Promise<void> {
      await db
        .prepare(
          "UPDATE earn_provider_actions SET unknown_signature_observed_at=COALESCE(unknown_signature_observed_at,sdp_iso_now()) WHERE id=? AND organization_id=? AND project_id=? AND status=?"
        )
        .bind(scope.actionId, scope.organizationId, scope.projectId, status)
        .run();
    },
    /**
     * The one cancellation still holding a movement's single active slot besides
     * `scope.actionId`, oldest first. A submit that lost the one-active-cancellation
     * race reports this row instead of its own unique-violation database error.
     */
    async findActiveCancellation(
      scope: Scope,
      parentMovementId: string
    ): Promise<EarnProviderActionRow | null> {
      const row = await db
        .prepare(
          `SELECT * FROM earn_provider_actions WHERE organization_id=? AND project_id=? AND parent_movement_id=? AND id<>? AND ${ONE_ACTIVE_CANCELLATION_SQL} ORDER BY created_at LIMIT 1`
        )
        .bind(scope.organizationId, scope.projectId, parentMovementId, scope.actionId)
        .first();
      return row === null ? null : rowSchema.parse(row);
    },
    async claimDue(
      environment: EarnProviderActionRow["environment"]
    ): Promise<EarnProviderActionRow | null> {
      const row = await db
        .prepare(`WITH due AS (SELECT id FROM earn_provider_actions WHERE environment=? AND status=ANY(?::text[]) AND next_check_at<=? ORDER BY next_check_at,id LIMIT 1 FOR UPDATE SKIP LOCKED)
        UPDATE earn_provider_actions a SET next_check_at=? FROM due WHERE a.id=due.id RETURNING a.*`)
        .bind(
          environment,
          EARN_PROVIDER_ACTION_DUE_STATUSES,
          new Date().toISOString(),
          new Date(Date.now() + 60_000).toISOString()
        )
        .first();
      return row === null ? null : rowSchema.parse(row);
    },
  };
}
