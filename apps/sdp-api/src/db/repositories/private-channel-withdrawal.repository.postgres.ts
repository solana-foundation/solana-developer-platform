import type { PrivateChannelTransferContext } from "@sdp/types";
import type { AppDb } from "@/db";
import {
  type CreateWithdrawalInput,
  generatePrivateChannelWithdrawalId,
  type PrivateChannelWithdrawalRepository,
  type PrivateChannelWithdrawalRow,
  type UpdateWithdrawalInput,
  type WithdrawalProjectScope,
} from "./private-channel-withdrawal.repository";

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

function mapRow(row: Record<string, unknown>): PrivateChannelWithdrawalRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    instance_id: row.instance_id as string,
    wallet_id: row.wallet_id as string,
    owner: row.owner as string,
    destination: row.destination as string,
    mint: row.mint as string,
    amount: row.amount as string,
    status: row.status as PrivateChannelWithdrawalRow["status"],
    signature: (row.signature ?? null) as string | null,
    settlement_ref: (row.settlement_ref ?? null) as string | null,
    failure_reason: (row.failure_reason ?? null) as string | null,
    context: readContext(row.context),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function createPostgresPrivateChannelWithdrawalRepository(
  db: AppDb
): PrivateChannelWithdrawalRepository {
  return {
    async createWithdrawal(input: CreateWithdrawalInput) {
      const row = await db
        .prepare(
          `INSERT INTO private_channel_withdrawals (
               id, organization_id, project_id, instance_id, wallet_id,
               owner, destination, mint, amount, context
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)
          RETURNING *`
        )
        .bind(
          generatePrivateChannelWithdrawalId(),
          input.organizationId,
          input.projectId,
          input.instanceId,
          input.walletId,
          input.owner,
          input.destination,
          input.mint,
          input.amount,
          JSON.stringify(input.context ?? {})
        )
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async updateWithdrawal(input: UpdateWithdrawalInput) {
      // COALESCE preserves fields the caller didn't touch. The (?::text IS NULL
      // OR status = ?) pair is a compare-and-swap guard against concurrent pollers.
      const row = await db
        .prepare(
          `UPDATE private_channel_withdrawals
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

    async getWithdrawalById(scope: WithdrawalProjectScope & { id: string }) {
      const row = await db
        .prepare(
          `SELECT * FROM private_channel_withdrawals
             WHERE organization_id = ? AND project_id = ? AND id = ?`
        )
        .bind(scope.organizationId, scope.projectId, scope.id)
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async listWithdrawalsByProject(scope: WithdrawalProjectScope) {
      const result = await db
        .prepare(
          `SELECT * FROM private_channel_withdrawals
             WHERE organization_id = ? AND project_id = ?
             ORDER BY created_at DESC, id DESC`
        )
        .bind(scope.organizationId, scope.projectId)
        .all<Record<string, unknown>>();
      return result.results.map(mapRow);
    },

    async listNonTerminalByProject(scope: WithdrawalProjectScope) {
      const result = await db
        .prepare(
          `SELECT * FROM private_channel_withdrawals
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
          `SELECT * FROM private_channel_withdrawals
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
          `SELECT COUNT(*)::int AS count FROM private_channel_withdrawals
             WHERE instance_id = ? AND status IN ('pending', 'submitted', 'confirmed')`
        )
        .bind(instanceId)
        .first<{ count: number }>();
      return row?.count ?? 0;
    },

    async patchContext(id: string, patch: PrivateChannelTransferContext) {
      await db
        .prepare(
          `UPDATE private_channel_withdrawals
              SET context = context || ?::jsonb
            WHERE id = ?`
        )
        .bind(JSON.stringify(patch ?? {}), id)
        .run();
    },
  };
}
