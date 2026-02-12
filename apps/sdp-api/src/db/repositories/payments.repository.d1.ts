import { and, eq, inArray } from "drizzle-orm";
import { paymentTransfers, paymentWalletPolicies } from "../drizzle/schema/sqlite";
import type {
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
  mode: row.mode as PaymentWalletPolicyRow["mode"],
  destination_allowlist: row.destinationAllowlist,
  max_transfer_amount: row.maxTransferAmount,
  max_daily_amount: row.maxDailyAmount,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
});

const toTransferScopeWhere = (input: {
  organizationId: string;
  projectId: string | null;
  extra: ReturnType<typeof eq>;
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

  const getWalletPolicyInternal = async (custodyWalletId: string) => {
    return db
      .select()
      .from(paymentWalletPolicies)
      .where(eq(paymentWalletPolicies.custodyWalletId, custodyWalletId))
      .get();
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

    async getWalletPolicyByCustodyWalletId(custodyWalletId) {
      const row = await getWalletPolicyInternal(custodyWalletId);
      return row ? mapPolicyRow(row) : null;
    },

    async upsertWalletPolicy(input) {
      await db
        .insert(paymentWalletPolicies)
        .values({
          id: input.id,
          custodyWalletId: input.custodyWalletId,
          mode: input.mode,
          destinationAllowlist: input.destinationAllowlist,
          maxTransferAmount: input.maxTransferAmount,
          maxDailyAmount: input.maxDailyAmount,
          createdAt: input.createdAt,
          updatedAt: input.updatedAt,
        })
        .onConflictDoUpdate({
          target: paymentWalletPolicies.custodyWalletId,
          set: {
            mode: input.mode,
            destinationAllowlist: input.destinationAllowlist,
            maxTransferAmount: input.maxTransferAmount,
            maxDailyAmount: input.maxDailyAmount,
            updatedAt: input.updatedAt,
          },
        })
        .run();

      const row = await getWalletPolicyInternal(input.custodyWalletId);
      return row ? mapPolicyRow(row) : null;
    },
  };
};
