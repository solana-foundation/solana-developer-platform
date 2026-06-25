import type { DatabaseExecutor } from "@/db";
import type {
  CreatePaymentTransferInput,
  ListTransfersByStatusInput,
  ListTransfersInput,
  ListTransfersResult,
  PaymentsRepository,
  PaymentTransferRow,
  PaymentWalletPolicyRow,
  UpdatePaymentTransferInput,
  UpsertPaymentWalletPolicyInput,
} from "./payments.repository";
import { generatePaymentTransferId } from "./payments.repository";

function buildInClause(length: number): string {
  return Array.from({ length }, () => "?").join(", ");
}

function mapTransferRow(row: Record<string, unknown>): PaymentTransferRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: (row.project_id as string | null | undefined) ?? null,
    wallet_id: row.wallet_id as string,
    counterparty_id: row.counterparty_id as string | null,
    source_address: row.source_address as string | null,
    destination_address: row.destination_address as string | null,
    token: row.token as string,
    amount: row.amount as string | null,
    memo: (row.memo as string | null | undefined) ?? null,
    type: row.type as PaymentTransferRow["type"],
    direction: row.direction as PaymentTransferRow["direction"],
    status: row.status as PaymentTransferRow["status"],
    provider: row.provider as PaymentTransferRow["provider"],
    provider_reference: row.provider_reference as string | null,
    delivery_mode: row.delivery_mode as PaymentTransferRow["delivery_mode"],
    fiat_currency: row.fiat_currency as string | null,
    fiat_amount: row.fiat_amount as string | null,
    provider_data: row.provider_data as Record<string, unknown>,
    signature: (row.signature as string | null | undefined) ?? null,
    serialized_tx: (row.serialized_tx as string | null | undefined) ?? null,
    slot: (row.slot as number | null | undefined) ?? null,
    block_time: (row.block_time as string | null | undefined) ?? null,
    fee: (row.fee as number | null | undefined) ?? null,
    error: (row.error as string | null | undefined) ?? null,
    initiated_by_key_id: (row.initiated_by_key_id as string | null | undefined) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function mapPolicyRow(row: Record<string, unknown>): PaymentWalletPolicyRow {
  return {
    id: row.id as string,
    custody_wallet_id: row.custody_wallet_id as string,
    policy_type: row.policy_type as string,
    policy: row.policy as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function buildTransferScopeWhere(params: {
  organizationId: string;
  projectId: string | null;
  extraClauses?: string[];
  extraValues?: unknown[];
}) {
  const clauses = ["organization_id = ?"];
  const values: unknown[] = [params.organizationId];

  if (params.projectId) {
    clauses.push("project_id = ?");
    values.push(params.projectId);
  }

  if (params.extraClauses?.length) {
    clauses.push(...params.extraClauses);
  }

  if (params.extraValues?.length) {
    values.push(...params.extraValues);
  }

  return {
    where: clauses.join(" AND "),
    values,
  };
}

async function getWalletPoliciesInternal(
  db: DatabaseExecutor,
  custodyWalletId: string
): Promise<PaymentWalletPolicyRow[]> {
  const rows = await db
    .prepare(
      `SELECT *
       FROM payment_wallet_policies
       WHERE custody_wallet_id = ?
       ORDER BY created_at ASC`
    )
    .bind(custodyWalletId)
    .all<Record<string, unknown>>();

  return rows.results.map(mapPolicyRow);
}

export function createPostgresPaymentsRepository(db: DatabaseExecutor): PaymentsRepository {
  return {
    async createTransfer(input: CreatePaymentTransferInput) {
      const row = await db
        .prepare(
          `INSERT INTO payment_transfers (
             id,
             organization_id,
             project_id,
             wallet_id,
             counterparty_id,
             source_address,
             destination_address,
             token,
             amount,
             memo,
             type,
             direction,
             status,
             provider,
             provider_reference,
             delivery_mode,
             fiat_currency,
             fiat_amount,
             provider_data,
             serialized_tx,
             signature,
             slot,
             initiated_by_key_id,
             created_at,
             updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, sdp_iso_now(), sdp_iso_now())
           RETURNING *`
        )
        .bind(
          generatePaymentTransferId(),
          input.organizationId,
          input.projectId,
          input.walletId,
          input.counterpartyId,
          input.sourceAddress,
          input.destinationAddress,
          input.token,
          input.amount,
          input.memo,
          input.type,
          input.direction,
          input.status,
          input.provider,
          input.providerReference,
          input.deliveryMode,
          input.fiatCurrency,
          input.fiatAmount,
          JSON.stringify(input.providerData),
          input.serializedTx,
          input.signature,
          input.slot,
          input.initiatedByKeyId
        )
        .first<Record<string, unknown>>();

      return row ? mapTransferRow(row) : null;
    },

    async updateTransfer(input: UpdatePaymentTransferInput) {
      const clauses = ["id = ?"];
      const values: unknown[] = [input.transferId];

      if (input.organizationId) {
        clauses.push("organization_id = ?");
        values.push(input.organizationId);
      }
      if (input.projectId !== undefined) {
        clauses.push("project_id IS NOT DISTINCT FROM ?");
        values.push(input.projectId);
      }

      const row = await db
        .prepare(
          `UPDATE payment_transfers
           SET status = COALESCE(?, status),
               signature = CASE WHEN ?::boolean THEN ? ELSE signature END,
               serialized_tx = CASE WHEN ?::boolean THEN ? ELSE serialized_tx END,
               slot = CASE WHEN ?::boolean THEN ? ELSE slot END,
               block_time = CASE WHEN ?::boolean THEN ? ELSE block_time END,
               fee = CASE WHEN ?::boolean THEN ? ELSE fee END,
               amount = CASE WHEN ?::boolean THEN ? ELSE amount END,
               fiat_amount = CASE WHEN ?::boolean THEN ? ELSE fiat_amount END,
               provider_data = CASE WHEN ?::boolean THEN provider_data || ?::jsonb ELSE provider_data END,
               error = CASE WHEN ?::boolean THEN ? ELSE error END,
               updated_at = ?
           WHERE ${clauses.join(" AND ")}
           RETURNING *`
        )
        .bind(
          input.status ?? null,
          input.signature !== undefined,
          input.signature ?? null,
          input.serializedTx !== undefined,
          input.serializedTx ?? null,
          input.slot !== undefined,
          input.slot ?? null,
          input.blockTime !== undefined,
          input.blockTime ?? null,
          input.fee !== undefined,
          input.fee ?? null,
          input.amount !== undefined,
          input.amount ?? null,
          input.fiatAmount !== undefined,
          input.fiatAmount ?? null,
          input.providerData !== undefined,
          JSON.stringify(input.providerData ?? {}),
          input.error !== undefined,
          input.error ?? null,
          input.updatedAt,
          ...values
        )
        .first<Record<string, unknown>>();

      return row ? mapTransferRow(row) : null;
    },

    async updateTransferStatusGuarded(input) {
      const scope = buildTransferScopeWhere({
        organizationId: input.organizationId,
        projectId: input.projectId,
        extraClauses: ["id = ?", "status = ANY(?)"],
        extraValues: [input.transferId, [...input.fromStatuses]],
      });

      const row = await db
        .prepare(
          `UPDATE payment_transfers
           SET status = ?, updated_at = ?
           WHERE ${scope.where}
           RETURNING *`
        )
        .bind(input.toStatus, input.updatedAt, ...scope.values)
        .first<Record<string, unknown>>();

      return row ? mapTransferRow(row) : null;
    },

    async getTransferById(params) {
      const scope = buildTransferScopeWhere({
        organizationId: params.organizationId,
        projectId: params.projectId,
        extraClauses: ["id = ?"],
        extraValues: [params.transferId],
      });

      const row = await db
        .prepare(`SELECT * FROM payment_transfers WHERE ${scope.where}`)
        .bind(...scope.values)
        .first<Record<string, unknown>>();

      return row ? mapTransferRow(row) : null;
    },

    async getTransferBySignature(params) {
      const scope = buildTransferScopeWhere({
        organizationId: params.organizationId,
        projectId: params.projectId,
        extraClauses: ["signature = ?"],
        extraValues: [params.signature],
      });

      const row = await db
        .prepare(`SELECT * FROM payment_transfers WHERE ${scope.where}`)
        .bind(...scope.values)
        .first<Record<string, unknown>>();

      return row ? mapTransferRow(row) : null;
    },

    async getTransferByProviderReference(params) {
      const scope = params.organizationId
        ? buildTransferScopeWhere({
            organizationId: params.organizationId,
            projectId: params.projectId,
            extraClauses: ["provider = ?", "provider_reference = ?"],
            extraValues: [params.provider, params.providerReference],
          })
        : {
            where: "provider = ? AND provider_reference = ?",
            values: [params.provider, params.providerReference],
          };

      const row = await db
        .prepare(`SELECT * FROM payment_transfers WHERE ${scope.where}`)
        .bind(...scope.values)
        .first<Record<string, unknown>>();

      return row ? mapTransferRow(row) : null;
    },

    async listTransfersBySignatures(params) {
      if (params.signatures.length === 0) {
        return [];
      }

      const scope = buildTransferScopeWhere({
        organizationId: params.organizationId,
        projectId: params.projectId,
        extraClauses: [`signature IN (${buildInClause(params.signatures.length)})`],
        extraValues: params.signatures,
      });

      const rows = await db
        .prepare(`SELECT * FROM payment_transfers WHERE ${scope.where}`)
        .bind(...scope.values)
        .all<Record<string, unknown>>();

      return rows.results.map(mapTransferRow);
    },

    async listTransfers(params: ListTransfersInput): Promise<ListTransfersResult> {
      const clauses = ["organization_id = ?"];
      const values: unknown[] = [params.organizationId];

      if (params.projectId) {
        clauses.push("project_id = ?");
        values.push(params.projectId);
      }
      if (params.walletId) {
        clauses.push("wallet_id = ?");
        values.push(params.walletId);
      }
      if (params.walletIds?.length) {
        clauses.push(`wallet_id IN (${buildInClause(params.walletIds.length)})`);
        values.push(...params.walletIds);
      }
      if (params.counterpartyId) {
        clauses.push("counterparty_id = ?");
        values.push(params.counterpartyId);
      }
      if (params.sourceAddress) {
        clauses.push("source_address = ?");
        values.push(params.sourceAddress);
      }
      if (params.token) {
        clauses.push("token = ?");
        values.push(params.token);
      }
      if (params.direction) {
        clauses.push("direction = ?");
        values.push(params.direction);
      }
      if (params.statuses?.length) {
        clauses.push(`status IN (${buildInClause(params.statuses.length)})`);
        values.push(...params.statuses);
      }
      if (params.types?.length) {
        clauses.push(`type IN (${buildInClause(params.types.length)})`);
        values.push(...params.types);
      }
      if (params.createdAtFrom) {
        clauses.push("created_at >= ?");
        values.push(params.createdAtFrom);
      }
      if (params.createdAtTo) {
        clauses.push("created_at <= ?");
        values.push(params.createdAtTo);
      }

      const whereClause = clauses.join(" AND ");
      const paginationValues = [...values, params.limit, params.offset];

      const [rows, countRow] = await Promise.all([
        db
          .prepare(
            `SELECT *
             FROM payment_transfers
             WHERE ${whereClause}
             ORDER BY created_at DESC
             LIMIT ?
             OFFSET ?`
          )
          .bind(...paginationValues)
          .all<Record<string, unknown>>(),
        db
          .prepare(`SELECT COUNT(*) AS count FROM payment_transfers WHERE ${whereClause}`)
          .bind(...values)
          .first<{ count: number }>(),
      ]);

      return {
        rows: rows.results.map(mapTransferRow),
        total: countRow?.count ?? 0,
      };
    },

    async listTransferAmounts(params) {
      if (params.statuses.length === 0) {
        return [];
      }

      const scope = buildTransferScopeWhere({
        organizationId: params.organizationId,
        projectId: params.projectId,
        extraClauses: [
          "wallet_id = ?",
          "token = ?",
          "direction = ?",
          `status IN (${buildInClause(params.statuses.length)})`,
          "created_at >= ?",
          "created_at < ?",
        ],
        extraValues: [
          params.walletId,
          params.token,
          params.direction,
          ...params.statuses,
          params.createdAtFrom,
          params.createdAtTo,
        ],
      });

      const rows = await db
        .prepare(`SELECT amount FROM payment_transfers WHERE ${scope.where}`)
        .bind(...scope.values)
        .all<{ amount: string }>();

      return rows.results.map((row) => row.amount);
    },

    async listTransfersByStatus({
      statuses,
      types,
      hasSignature,
      createdBefore,
      updatedBefore,
      limit,
      offset,
    }: ListTransfersByStatusInput) {
      if (statuses.length === 0) {
        return [];
      }

      const clauses = [`status IN (${buildInClause(statuses.length)})`];
      const values: unknown[] = [...statuses];

      if (types?.length) {
        clauses.push(`type IN (${buildInClause(types.length)})`);
        values.push(...types);
      }
      if (hasSignature === true) {
        clauses.push("signature IS NOT NULL");
      } else if (hasSignature === false) {
        clauses.push("signature IS NULL");
      }
      if (createdBefore) {
        clauses.push("created_at < ?");
        values.push(createdBefore);
      }
      if (updatedBefore) {
        clauses.push("updated_at < ?");
        values.push(updatedBefore);
      }

      const rows = await db
        .prepare(
          `SELECT *
           FROM payment_transfers
           WHERE ${clauses.join(" AND ")}
           ORDER BY updated_at ASC
           LIMIT ?
           OFFSET ?`
        )
        .bind(...values, limit, offset ?? 0)
        .all<Record<string, unknown>>();

      return rows.results.map(mapTransferRow);
    },

    async getWalletPoliciesByCustodyWalletId(custodyWalletId) {
      return getWalletPoliciesInternal(db, custodyWalletId);
    },

    async upsertWalletPolicies(inputs: UpsertPaymentWalletPolicyInput[]) {
      if (inputs.length === 0) {
        return [];
      }

      for (const input of inputs) {
        await db
          .prepare(
            `INSERT INTO payment_wallet_policies (
               id,
               custody_wallet_id,
               policy_type,
               policy,
               created_at,
               updated_at
             ) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (custody_wallet_id, policy_type)
             DO UPDATE SET
               policy = EXCLUDED.policy,
               updated_at = EXCLUDED.updated_at`
          )
          .bind(
            input.id,
            input.custodyWalletId,
            input.policyType,
            input.policy,
            input.createdAt,
            input.updatedAt
          )
          .run();
      }

      return getWalletPoliciesInternal(db, inputs[0].custodyWalletId);
    },
  };
}
