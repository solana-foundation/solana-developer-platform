import { createClusterRpc } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import {
  getSignatureStatuses,
  getTransaction,
  type ParsedTransaction,
  type SignatureStatusInfo,
  type SolanaRpc,
  tokenBalanceDelta,
} from "@sdp/rpc/solana";
import { formatDecimalAmount, parseDecimalAmount } from "@sdp/solana/amount";
import { SOL_DECIMALS, SOL_MINT, WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types/well-known-tokens";
import { assertIsSignature, type Signature } from "@solana/kit";
import { z } from "zod";
import type { PaymentsRepository, PaymentTransferRow } from "@/db/repositories/payments.repository";
import { createSystemPaymentsRepository } from "@/db/repositories/repository-factory";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";

// One status request covers every off-ramp on this page. On-ramps need one
// transaction read each to prove the quoted mint reached the quoted wallet.
const MAX_PER_SWEEP = 64;

export interface RampChainReader {
  getTransaction(signature: Signature): Promise<ParsedTransaction | null>;
  getSignatureStatuses(signatures: Signature[]): Promise<Array<SignatureStatusInfo | null>>;
}

function createRampChainReader(rpc: SolanaRpc = createClusterRpc()): RampChainReader {
  return {
    getTransaction: (signature) => getTransaction(rpc, signature, "finalized"),
    getSignatureStatuses: (signatures) =>
      getSignatureStatuses(rpc, signatures, { searchTransactionHistory: true }),
  };
}

const providerSettlementSchema = z
  .object({
    reference: z.string(),
    observedAt: z.string().optional(),
    onchain: z
      .object({
        signature: z.string(),
        sourceAddress: z.string().optional(),
        destinationAddress: z.string().optional(),
        amount: z.string().optional(),
      })
      .passthrough()
      .optional(),
    receivedAmount: z.string().optional(),
    refundAddress: z.string().optional(),
  })
  .passthrough();
type ProviderSettlement = z.infer<typeof providerSettlementSchema>;

function providerSettlement(transfer: PaymentTransferRow): ProviderSettlement | null {
  const parsed = providerSettlementSchema.safeParse(transfer.provider_data.providerSettlement);
  return parsed.success && parsed.data.reference === transfer.provider_reference
    ? parsed.data
    : null;
}

function signature(value: unknown): Signature | null {
  if (typeof value !== "string") return null;
  try {
    assertIsSignature(value);
    return value;
  } catch {
    return null;
  }
}

function reportedFieldsMatch(transfer: PaymentTransferRow, settled: ProviderSettlement): boolean {
  const onchain = settled.onchain;
  if (
    onchain?.destinationAddress !== undefined &&
    onchain.destinationAddress !== transfer.destination_address
  ) {
    return false;
  }
  if (transfer.type === "offramp") {
    if (onchain?.sourceAddress !== undefined && onchain.sourceAddress !== transfer.source_address) {
      return false;
    }
    if (onchain?.signature !== undefined && onchain.signature !== transfer.signature) {
      return false;
    }
    if (onchain?.amount !== undefined && transfer.amount !== null) {
      try {
        const token = WELL_KNOWN_TOKEN_BY_MINT.get(transfer.token);
        if (
          !token?.clusters.includes(currentClusterScope().cluster) ||
          parseDecimalAmount(onchain.amount, token.decimals) !==
            parseDecimalAmount(transfer.amount, token.decimals)
        ) {
          return false;
        }
      } catch {
        return false;
      }
    }
  }
  return true;
}

function onrampReceivedAmount(
  transfer: PaymentTransferRow,
  settled: ProviderSettlement,
  transaction: ParsedTransaction
): string | null {
  const destination = transfer.destination_address;
  const token = WELL_KNOWN_TOKEN_BY_MINT.get(transfer.token);
  if (
    !destination ||
    !token?.clusters.includes(currentClusterScope().cluster) ||
    !transaction.executionResultKnown ||
    transaction.err !== null
  ) {
    return null;
  }
  let baseUnits: bigint;
  let decimals: number;
  if (transfer.token === SOL_MINT) {
    const index = transaction.accountKeys?.indexOf(destination) ?? -1;
    if (
      index < 0 ||
      transaction.preBalances?.[index] === undefined ||
      transaction.postBalances?.[index] === undefined
    ) {
      return null;
    }
    baseUnits = transaction.postBalances[index] - transaction.preBalances[index];
    decimals = SOL_DECIMALS;
  } else {
    const delta = tokenBalanceDelta(transaction, { mint: transfer.token, owner: destination });
    if (!delta || delta.decimals !== token.decimals) return null;
    baseUnits = delta.baseUnits;
    decimals = delta.decimals;
  }
  if (baseUnits <= 0n) return null;
  try {
    if (transfer.amount !== null && baseUnits < parseDecimalAmount(transfer.amount, decimals)) {
      return null;
    }
    for (const reported of [settled.receivedAmount, settled.onchain?.amount]) {
      if (reported === undefined) continue;
      if (parseDecimalAmount(reported, decimals) !== baseUnits) {
        return null;
      }
    }
  } catch {
    return null;
  }
  return formatDecimalAmount(baseUnits, decimals);
}

async function verifyOnramp(
  repo: PaymentsRepository,
  chain: RampChainReader,
  transfer: PaymentTransferRow,
  settled: ProviderSettlement
): Promise<boolean> {
  const transactionSignature = signature(settled.onchain?.signature);
  if (
    !transactionSignature ||
    transactionSignature !== transfer.signature ||
    !reportedFieldsMatch(transfer, settled)
  ) {
    return false;
  }
  const transaction = await chain.getTransaction(transactionSignature);
  if (!transaction) return false;
  const amount = onrampReceivedAmount(transfer, settled, transaction);
  if (amount === null || transaction.slot > BigInt(Number.MAX_SAFE_INTEGER)) return false;
  const slot = Number(transaction.slot);
  const update: Parameters<PaymentsRepository["transitionRampTransfer"]>[0] = {
    transferId: transfer.id,
    organizationId: transfer.organization_id,
    projectId: transfer.project_id,
    transition: "delivery_verified",
    deliveryEvidence: { providerSettlement: settled, signature: transactionSignature },
    providerData: {
      verifiedDelivery: {
        signature: transactionSignature,
        slot,
        token: transfer.token,
        destinationAddress: transfer.destination_address,
        amount,
      },
    },
    slot,
    updatedAt: new Date().toISOString(),
  };
  if (transfer.amount === null) update.amount = amount;
  return (await repo.transitionRampTransfer(update)) !== null;
}

async function verifyOfframps(
  repo: PaymentsRepository,
  chain: RampChainReader,
  transfers: PaymentTransferRow[]
): Promise<string[]> {
  const eligible = transfers.flatMap((transfer) => {
    const settled = providerSettlement(transfer);
    const submittedSignature = signature(transfer.signature);
    return settled &&
      submittedSignature &&
      transfer.signed_transaction &&
      transfer.submission_started_at &&
      reportedFieldsMatch(transfer, settled)
      ? [{ transfer, settled, submittedSignature }]
      : [];
  });
  if (eligible.length === 0) return [];
  const statuses = await chain.getSignatureStatuses(
    eligible.map(({ submittedSignature }) => submittedSignature)
  );
  if (statuses.length !== eligible.length) {
    throw new Error("Ramp deposit status batch length mismatch");
  }
  const completed: string[] = [];
  for (const [index, entry] of eligible.entries()) {
    const status = statuses[index];
    if (status?.confirmationStatus !== "finalized" || status.err !== null) continue;
    if (BigInt(status.slot) > BigInt(Number.MAX_SAFE_INTEGER)) continue;
    try {
      const updated = await repo.transitionRampTransfer({
        transferId: entry.transfer.id,
        organizationId: entry.transfer.organization_id,
        projectId: entry.transfer.project_id,
        transition: "delivery_verified",
        deliveryEvidence: {
          providerSettlement: entry.settled,
          signature: entry.submittedSignature,
        },
        providerData: {
          verifiedDelivery: {
            signature: entry.submittedSignature,
            slot: Number(status.slot),
          },
        },
        slot: Number(status.slot),
        updatedAt: new Date().toISOString(),
      });
      if (updated !== null) completed.push(entry.transfer.id);
    } catch (error) {
      getLogger().error(
        { transfer_id: entry.transfer.id, error },
        "verifyRampDeliveries: off-ramp update failed"
      );
    }
  }
  return completed;
}

/** Reconcile provider completion against one cluster without trusting its delivery claim. */
export async function verifyRampDeliveries(
  env: Env,
  chain: RampChainReader = createRampChainReader(),
  repo: PaymentsRepository = createSystemPaymentsRepository(env)
): Promise<void> {
  const transfers = await repo.listRampTransfersToVerify({
    environment: currentClusterScope().environment,
    limit: MAX_PER_SWEEP,
  });
  if (transfers.length === 0) return;
  const onramps = transfers.filter((transfer) => transfer.type === "onramp");
  const offramps = transfers.filter((transfer) => transfer.type === "offramp");
  const completed = new Set<string>();
  try {
    try {
      for (const id of await verifyOfframps(repo, chain, offramps)) completed.add(id);
    } catch (error) {
      getLogger().error(
        { environment: currentClusterScope().environment, error },
        "verifyRampDeliveries: off-ramp status read failed"
      );
    }
    for (const transfer of onramps) {
      const settled = providerSettlement(transfer);
      if (!settled) continue;
      try {
        if (await verifyOnramp(repo, chain, transfer, settled)) completed.add(transfer.id);
      } catch (error) {
        getLogger().error(
          { transfer_id: transfer.id, error },
          "verifyRampDeliveries: on-ramp lookup failed"
        );
      }
    }
  } finally {
    await repo.markRampTransfersVerificationPolled({
      transferIds: transfers.map((transfer) => transfer.id),
      polledAt: new Date().toISOString(),
    });
  }
  if (completed.size < transfers.length) {
    getLogger().warn(
      {
        environment: currentClusterScope().environment,
        polled: transfers.length,
        completed: completed.size,
        pending_transfer_ids: transfers
          .filter((transfer) => !completed.has(transfer.id))
          .map((transfer) => transfer.id),
      },
      "verifyRampDeliveries: provider settlement still lacks matching chain proof"
    );
  }
}
