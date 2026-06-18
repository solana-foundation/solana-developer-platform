import type { AppDb } from "@/db";
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

async function getTransferByIdInternal(
  db: AppDb,
  transferId: string
): Promise<PaymentTransferRow | null> {
  const row = await db
    .prepare("SELECT * FROM payment_transfers WHERE id = ?")
    .bind(transferId)
    .first<Record<string, unknown>>();

  return row ? mapTransferRow(row) : null;
}

async function getWalletPoliciesInternal(
  db: AppDb,
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

export function createPostgresPaymentsRepository(db: AppDb): PaymentsRepository {
  return {
    async createTransfer(input: CreatePaymentTransferInput) {
      await db
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
             initiated_by_key_id,
             created_at,
             updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?)`
        )
        .bind(
          input.id,
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
          input.initiatedByKeyId,
          input.createdAt,
          input.updatedAt
        )
        .run();

      return getTransferByIdInternal(db, input.id);
    },

    async updateTransfer(input: UpdatePaymentTransferInput) {
      const existing = await getTransferByIdInternal(db, input.transferId);
      if (!existing) {
        return null;
      }

      await db
        .prepare(
          `UPDATE payment_transfers
           SET status = ?,
               signature = ?,
               serialized_tx = ?,
               slot = ?,
               block_time = ?,
               fee = ?,
               amount = ?,
               fiat_amount = ?,
               provider_data = ?::jsonb,
               error = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .bind(
          input.status ?? existing.status,
          input.signature ?? existing.signature,
          input.serializedTx ?? existing.serialized_tx,
          input.slot ?? existing.slot,
          input.blockTime ?? existing.block_time,
          input.fee ?? existing.fee,
          input.amount ?? existing.amount,
          input.fiatAmount ?? existing.fiat_amount,
          JSON.stringify(
            input.providerData
              ? { ...existing.provider_data, ...input.providerData }
              : existing.provider_data
          ),
          input.error ?? existing.error,
          input.updatedAt,
          input.transferId
        )
        .run();

      return getTransferByIdInternal(db, input.transferId);
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
