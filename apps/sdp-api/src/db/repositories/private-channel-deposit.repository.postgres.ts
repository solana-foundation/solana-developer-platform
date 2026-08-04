import type { PrivateChannelTransferContext } from "@sdp/types";
import type { AppDb } from "@/db";
import {
  type CreateDepositInput,
  type DepositProjectScope,
  generatePrivateChannelDepositId,
  type PrivateChannelDepositRepository,
  type PrivateChannelDepositRow,
  type UpdateDepositInput,
} from "./private-channel-deposit.repository";

function readContext(raw: unknown): PrivateChannelTransferContext {
  if (raw && typeof raw === "object") {
    return raw as PrivateChannelTransferContext;
  }
  if (typeof raw === "string" && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed as PrivateChannelTransferContext;
    } catch {
      // fall through
    }
  }
  return {};
}

function mapRow(row: Record<string, unknown>): PrivateChannelDepositRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    instance_id: row.instance_id as string,
    wallet_id: row.wallet_id as string,
    depositor: row.depositor as string,
    recipient: row.recipient as string,
    mint: row.mint as string,
    amount: row.amount as string,
    status: row.status as PrivateChannelDepositRow["status"],
    signature: (row.signature ?? null) as string | null,
    settlement_ref: (row.settlement_ref ?? null) as string | null,
    failure_reason: (row.failure_reason ?? null) as string | null,
    context: readContext(row.context),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function createPostgresPrivateChannelDepositRepository(
  db: AppDb
): PrivateChannelDepositRepository {
  return {
    async createDeposit(input: CreateDepositInput) {
      const row = await db
        .prepare(
          `INSERT INTO private_channel_deposits (
               id, organization_id, project_id, instance_id, wallet_id,
               depositor, recipient, mint, amount, context
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)
          RETURNING *`
        )
        .bind(
          generatePrivateChannelDepositId(),
          input.organizationId,
          input.projectId,
          input.instanceId,
          input.walletId,
          input.depositor,
          input.recipient,
          input.mint,
          input.amount,
          JSON.stringify(input.context ?? {})
        )
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async updateDeposit(input: UpdateDepositInput) {
      // COALESCE preserves fields the caller didn't touch. The (?::text IS NULL
      // OR status = ?) pair is a compare-and-swap guard — the update returns 0
      // rows if the intent moved on, so a concurrent poller can't regress state.
      const row = await db
        .prepare(
          `UPDATE private_channel_deposits
              SET status = ?,
                  signature = COALESCE(?, signature),
                  settlement_ref = COALESCE(?, settlement_ref),
                  failure_reason = COALESCE(?, failure_reason),
                  updated_at = sdp_iso_now()
            WHERE id = ?
              AND (?::text IS NULL OR status = ?)
          RETURNING *`
        )
        .bind(
          input.status,
          input.signature ?? null,
          input.settlementRef ?? null,
          input.failureReason ?? null,
          input.id,
          input.expectedStatus ?? null,
          input.expectedStatus ?? null
        )
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async getDepositById(scope: DepositProjectScope & { id: string }) {
      const row = await db
        .prepare(
          `SELECT * FROM private_channel_deposits
             WHERE organization_id = ? AND project_id = ? AND id = ?`
        )
        .bind(scope.organizationId, scope.projectId, scope.id)
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async listDepositsByProject(scope: DepositProjectScope) {
      const result = await db
        .prepare(
          `SELECT * FROM private_channel_deposits
             WHERE organization_id = ? AND project_id = ?
             ORDER BY created_at DESC, id DESC`
        )
        .bind(scope.organizationId, scope.projectId)
        .all<Record<string, unknown>>();
      return result.results.map(mapRow);
    },

    async listNonTerminalByProject(scope: DepositProjectScope) {
      const result = await db
        .prepare(
          `SELECT * FROM private_channel_deposits
             WHERE organization_id = ? AND project_id = ?
               AND status IN ('pending', 'submitted', 'confirmed')
             ORDER BY updated_at ASC, id ASC`
        )
        .bind(scope.organizationId, scope.projectId)
        .all<Record<string, unknown>>();
      return result.results.map(mapRow);
    },

    async listNonTerminal(limit: number) {
      const result = await db
        .prepare(
          // Tie-broken because of the LIMIT: this is the cron's work queue, so
          // rows sharing an updated_at at the cutoff would otherwise be included
          // or dropped arbitrarily from tick to tick, and one could be starved.
          `SELECT * FROM private_channel_deposits
             WHERE status IN ('pending', 'submitted', 'confirmed')
             ORDER BY updated_at ASC, id ASC
             LIMIT ?`
        )
        .bind(limit)
        .all<Record<string, unknown>>();
      return result.results.map(mapRow);
    },

    async countNonTerminalByInstance(instanceId: string) {
      const row = await db
        .prepare(
          `SELECT COUNT(*)::int AS count FROM private_channel_deposits
             WHERE instance_id = ? AND status IN ('pending', 'submitted', 'confirmed')`
        )
        .bind(instanceId)
        .first<{ count: number }>();
      return row?.count ?? 0;
    },

    async patchContext(id: string, patch: PrivateChannelTransferContext) {
      // jsonb || jsonb is a right-biased merge — the patch wins for shared keys.
      await db
        .prepare(
          `UPDATE private_channel_deposits
              SET context = context || ?::jsonb
            WHERE id = ?`
        )
        .bind(JSON.stringify(patch ?? {}), id)
        .run();
    },
  };
}
