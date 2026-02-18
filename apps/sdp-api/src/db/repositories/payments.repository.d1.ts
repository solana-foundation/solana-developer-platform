import { type SQL, and, eq, gte, inArray, lt } from "drizzle-orm";
import { paymentTransfers, paymentWalletPolicies } from "../drizzle/schema/sqlite";
import type {
  PaymentTransferRow,
  PaymentWalletPolicyRow,
  PaymentsRepository,
  PaymentsRepositoryContext,
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
