import {
  type SQL,
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  sql,
} from "drizzle-orm";
import { paymentTransfers, paymentWalletPolicies } from "../drizzle/schema/sqlite";
import type {
  ListTransfersByStatusInput,
  ListTransfersInput,
  ListTransfersResult,
  PaymentTransferRow,
  PaymentWalletPolicyRow,
  PaymentsRepository,
  PaymentsRepositoryContext,
  UpdatePaymentTransferInput,
} from "./payments.repository";

const mapTransferRow = (row: typeof paymentTransfers.$inferSelect): PaymentTransferRow => ({
  id: row.id,
  organization_id: row.organizationId,
  project_id: row.projectId,
  wallet_id: row.walletId,
  source_address: row.sourceAddress,
  destination_address: row.destinationAddress,
  token: row.token,
  amount: row.amount,
  memo: row.memo,
  type: row.type as PaymentTransferRow["type"],
  direction: row.direction as PaymentTransferRow["direction"],
  status: row.status as PaymentTransferRow["status"],
  signature: row.signature,
  serialized_tx: row.serializedTx,
  slot: row.slot,
  block_time: row.blockTime,
  fee: row.fee,
  error: row.error,
  initiated_by_key_id: row.initiatedByKeyId,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
});

const mapPolicyRow = (row: typeof paymentWalletPolicies.$inferSelect): PaymentWalletPolicyRow => ({
  id: row.id,
  custody_wallet_id: row.custodyWalletId,
  policy_type: row.policyType,
  policy: row.policy,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
});

const toTransferScopeWhere = (input: {
  organizationId: string;
  projectId: string | null;
  extra: SQL<unknown>;
}) =>
  input.projectId
    ? and(
        input.extra,
        eq(paymentTransfers.organizationId, input.organizationId),
        eq(paymentTransfers.projectId, input.projectId)
      )
    : and(input.extra, eq(paymentTransfers.organizationId, input.organizationId));

export const createD1PaymentsRepository = (
  context: PaymentsRepositoryContext
): PaymentsRepository => {
  const { db } = context;

  const getTransferByIdInternal = async (transferId: string) => {
    return db.select().from(paymentTransfers).where(eq(paymentTransfers.id, transferId)).get();
  };

  const getWalletPoliciesInternal = async (custodyWalletId: string) => {
    return db
      .select()
      .from(paymentWalletPolicies)
      .where(eq(paymentWalletPolicies.custodyWalletId, custodyWalletId))
      .all();
  };

  const buildTransferUpdateSet = (
    existing: typeof paymentTransfers.$inferSelect,
    input: UpdatePaymentTransferInput
  ) => ({
    status: input.status ?? existing.status,
    signature: input.signature ?? existing.signature,
    serializedTx: input.serializedTx ?? existing.serializedTx,
    slot: input.slot ?? existing.slot,
    blockTime: input.blockTime ?? existing.blockTime,
    fee: input.fee ?? existing.fee,
    error: input.error ?? existing.error,
    updatedAt: input.updatedAt,
  });

  return {
    async createTransfer(input) {
      await db
        .insert(paymentTransfers)
        .values({
          id: input.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          walletId: input.walletId,
          sourceAddress: input.sourceAddress,
          destinationAddress: input.destinationAddress,
          token: input.token,
          amount: input.amount,
          memo: input.memo,
          type: input.type,
          direction: input.direction,
          status: input.status,
          serializedTx: input.serializedTx,
          initiatedByKeyId: input.initiatedByKeyId,
          createdAt: input.createdAt,
          updatedAt: input.updatedAt,
        })
        .run();

      const row = await getTransferByIdInternal(input.id);
      return row ? mapTransferRow(row) : null;
    },

    async updateTransfer(input) {
      const existing = await getTransferByIdInternal(input.transferId);
      if (!existing) {
        return null;
      }

      await db
        .update(paymentTransfers)
        .set(buildTransferUpdateSet(existing, input))
        .where(eq(paymentTransfers.id, input.transferId))
        .run();

      const updated = await getTransferByIdInternal(input.transferId);
      return updated ? mapTransferRow(updated) : null;
    },

    async getTransferById(params) {
      const row = await db
        .select()
        .from(paymentTransfers)
        .where(
          toTransferScopeWhere({
            organizationId: params.organizationId,
            projectId: params.projectId,
            extra: eq(paymentTransfers.id, params.transferId),
          })
        )
        .get();

      return row ? mapTransferRow(row) : null;
    },

    async getTransferBySignature(params) {
      const row = await db
        .select()
        .from(paymentTransfers)
        .where(
          toTransferScopeWhere({
            organizationId: params.organizationId,
            projectId: params.projectId,
            extra: eq(paymentTransfers.signature, params.signature),
          })
        )
        .get();

      return row ? mapTransferRow(row) : null;
    },

    async listTransfersBySignatures(params) {
      if (params.signatures.length === 0) {
        return [];
      }

      const rows = await db
        .select()
        .from(paymentTransfers)
        .where(
          toTransferScopeWhere({
            organizationId: params.organizationId,
            projectId: params.projectId,
            extra: inArray(paymentTransfers.signature, params.signatures),
          })
        )
        .all();

      return rows.map(mapTransferRow);
    },

    async listTransfers(params: ListTransfersInput): Promise<ListTransfersResult> {
      const conditions: SQL[] = [eq(paymentTransfers.organizationId, params.organizationId)];
      if (params.projectId) conditions.push(eq(paymentTransfers.projectId, params.projectId));
      if (params.walletId) conditions.push(eq(paymentTransfers.walletId, params.walletId));
      if (params.sourceAddress)
        conditions.push(eq(paymentTransfers.sourceAddress, params.sourceAddress));
      if (params.token) conditions.push(eq(paymentTransfers.token, params.token));
      if (params.direction) conditions.push(eq(paymentTransfers.direction, params.direction));
      if (params.statuses?.length)
        conditions.push(inArray(paymentTransfers.status, params.statuses));
      if (params.createdAtFrom)
        conditions.push(gte(paymentTransfers.createdAt, params.createdAtFrom));
      if (params.createdAtTo) conditions.push(lte(paymentTransfers.createdAt, params.createdAtTo));

      const where = and(...conditions);

      const [rows, countRow] = await Promise.all([
        db
          .select()
          .from(paymentTransfers)
          .where(where)
          .orderBy(desc(paymentTransfers.createdAt))
          .limit(params.limit)
          .offset(params.offset)
          .all(),
        db.select({ count: sql<number>`count(*)` }).from(paymentTransfers).where(where).get(),
      ]);

      return { rows: rows.map(mapTransferRow), total: countRow?.count ?? 0 };
    },

    async listTransferAmounts(params) {
      if (params.statuses.length === 0) {
        return [];
      }

      const transferFilter = and(
        eq(paymentTransfers.walletId, params.walletId),
        eq(paymentTransfers.token, params.token),
        eq(paymentTransfers.direction, params.direction),
        inArray(paymentTransfers.status, params.statuses),
        gte(paymentTransfers.createdAt, params.createdAtFrom),
        lt(paymentTransfers.createdAt, params.createdAtTo)
      );
      if (!transferFilter) {
        return [];
      }

      const rows = await db
        .select({ amount: paymentTransfers.amount })
        .from(paymentTransfers)
        .where(
          toTransferScopeWhere({
            organizationId: params.organizationId,
            projectId: params.projectId,
            extra: transferFilter,
          })
        )
        .all();

      return rows.map((row) => row.amount);
    },

    async listTransfersByStatus({
      statuses,
      hasSignature,
      createdBefore,
      updatedBefore,
      limit,
      offset,
    }: ListTransfersByStatusInput): Promise<PaymentTransferRow[]> {
      if (statuses.length === 0) {
        return [];
      }

      const conditions: SQL[] = [inArray(paymentTransfers.status, statuses)];
      if (hasSignature === true) {
        conditions.push(isNotNull(paymentTransfers.signature));
      } else if (hasSignature === false) {
        conditions.push(isNull(paymentTransfers.signature));
      }
      if (createdBefore) {
        conditions.push(lt(paymentTransfers.createdAt, createdBefore));
      }
      if (updatedBefore) {
        conditions.push(lt(paymentTransfers.updatedAt, updatedBefore));
      }

      const rows = await db
        .select()
        .from(paymentTransfers)
        .where(and(...conditions))
        .orderBy(paymentTransfers.updatedAt)
        .limit(limit)
        .offset(offset ?? 0)
        .all();

      return rows.map(mapTransferRow);
    },

    async getWalletPoliciesByCustodyWalletId(custodyWalletId) {
      const rows = await getWalletPoliciesInternal(custodyWalletId);
      return rows.map(mapPolicyRow);
    },

    async upsertWalletPolicies(inputs) {
      if (inputs.length === 0) {
        return [];
      }

      for (const input of inputs) {
        await db
          .insert(paymentWalletPolicies)
          .values({
            id: input.id,
            custodyWalletId: input.custodyWalletId,
            policyType: input.policyType,
            policy: input.policy,
            createdAt: input.createdAt,
            updatedAt: input.updatedAt,
          })
          .onConflictDoUpdate({
            target: [paymentWalletPolicies.custodyWalletId, paymentWalletPolicies.policyType],
            set: {
              policy: input.policy,
              updatedAt: input.updatedAt,
            },
          })
          .run();
      }

      const rows = await getWalletPoliciesInternal(inputs[0].custodyWalletId);
      return rows.map(mapPolicyRow);
    },
  };
};
