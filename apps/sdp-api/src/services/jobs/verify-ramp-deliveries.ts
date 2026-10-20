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
import type { RampDeliveryMismatch, RampDeliveryMismatchReason } from "@sdp/types/payments";
import { SOL_DECIMALS, SOL_MINT, WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types/well-known-tokens";
import { assertIsSignature, type Signature } from "@solana/kit";
import type { PaymentsRepository, PaymentTransferRow } from "@/db/repositories/payments.repository";
import {
  createSystemPaymentsRepository,
  createSystemTransactionalPaymentsRepository,
} from "@/db/repositories/repository-factory";
import { getLogger } from "@/runtime/logger";
import { logEvent } from "@/runtime/money-path-events";
import { auditedRampWriteSystem } from "@/services/payments/ramp-audit";
import {
  currentProviderSettlement,
  type ProviderSettlement,
  readDeliveryMismatch,
} from "@/services/payments/ramp-provider-settlement";
import type { Env } from "@/types/env";

// One status request covers every off-ramp on this page. On-ramps need one
// transaction read each to prove the quoted mint reached the quoted wallet.
const MAX_PER_SWEEP = 64;

// Validator block times can trail wall-clock time by a little.
const DELIVERY_CLOCK_SKEW_SECONDS = 120n;

// A reported signature with no finalized transaction this long after the
// report never landed; finalization takes seconds.
const TRANSACTION_NOT_FOUND_AFTER_MS = 60 * 60 * 1000;

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

/** What one read of a finalized transaction proves about a provider-reported delivery. */
type DeliveryVerdict =
  | { kind: "verified"; amount: string }
  | { kind: "pending" }
  | { kind: "mismatch"; reason: RampDeliveryMismatchReason; observedAmount?: string };

const PENDING: DeliveryVerdict = { kind: "pending" };

function mismatch(reason: RampDeliveryMismatchReason, observedAmount?: string): DeliveryVerdict {
  return observedAmount === undefined
    ? { kind: "mismatch", reason }
    : { kind: "mismatch", reason, observedAmount };
}

/** Whether a transaction landed after SDP created the transfer; null when its block time is unknown. */
function landedAfterTransfer(
  transfer: PaymentTransferRow,
  transaction: ParsedTransaction
): boolean | null {
  const blockTime = transaction.blockTime ?? null;
  const createdAtMs = Date.parse(transfer.created_at);
  if (blockTime === null || !Number.isFinite(createdAtMs)) return null;
  return blockTime + DELIVERY_CLOCK_SKEW_SECONDS >= BigInt(Math.floor(createdAtMs / 1000));
}

/** The quoted asset's net movement into `destination`; "absent" when it moved none, null when unreadable. */
function deliveredBaseUnits(
  transfer: PaymentTransferRow,
  destination: string,
  decimals: number,
  transaction: ParsedTransaction
): bigint | "absent" | null {
  if (transfer.token === SOL_MINT) {
    if (transaction.accountKeys === undefined) return null;
    const index = transaction.accountKeys.indexOf(destination);
    if (index < 0) return "absent";
    const pre = transaction.preBalances?.[index];
    const post = transaction.postBalances?.[index];
    return pre === undefined || post === undefined ? null : post - pre;
  }
  if (transaction.preTokenBalances === undefined || transaction.postTokenBalances === undefined) {
    return null;
  }
  const delta = tokenBalanceDelta(transaction, { mint: transfer.token, owner: destination });
  if (delta === null) return "absent";
  return delta.decimals === decimals ? delta.baseUnits : null;
}

function judgeOnrampDelivery(
  transfer: PaymentTransferRow,
  settled: ProviderSettlement,
  transaction: ParsedTransaction
): DeliveryVerdict {
  const destination = transfer.destination_address;
  const token = WELL_KNOWN_TOKEN_BY_MINT.get(transfer.token);
  if (
    !destination ||
    !token?.clusters.includes(currentClusterScope().cluster) ||
    !transaction.executionResultKnown
  ) {
    return PENDING;
  }
  if (transaction.err !== null) return mismatch("transaction_failed");
  const landed = landedAfterTransfer(transfer, transaction);
  if (landed === null) return PENDING;
  if (!landed) return mismatch("predates_transfer");
  const decimals = transfer.token === SOL_MINT ? SOL_DECIMALS : token.decimals;
  const moved = deliveredBaseUnits(transfer, destination, decimals, transaction);
  if (moved === null) return PENDING;
  if (moved === "absent" || moved <= 0n) return mismatch("not_delivered");
  const observedAmount = formatDecimalAmount(moved, decimals);
  try {
    const short = transfer.amount !== null && moved < parseDecimalAmount(transfer.amount, decimals);
    const reported = [settled.receivedAmount, settled.onchain?.amount].filter(
      (amount): amount is string => amount !== undefined
    );
    if (short || reported.some((amount) => parseDecimalAmount(amount, decimals) !== moved)) {
      return mismatch("amount_mismatch", observedAmount);
    }
  } catch {
    return mismatch("amount_mismatch", observedAmount);
  }
  return { kind: "verified", amount: observedAmount };
}

/**
 * Records why the chain doesn't confirm a ramp's delivery. A contradiction
 * stops the re-reads, since that transaction can never change; a missing
 * transaction stays checked. A new provider report releases either hold.
 */
async function holdDelivery(
  repo: PaymentsRepository,
  transfer: PaymentTransferRow,
  settled: ProviderSettlement,
  verdict: { reason: RampDeliveryMismatchReason; observedAmount?: string }
): Promise<void> {
  // An off-ramp's receivedAmount is the fiat payout, never the deposit.
  const reportedAmount =
    transfer.type === "onramp"
      ? (settled.receivedAmount ?? settled.onchain?.amount)
      : settled.onchain?.amount;
  const checkedAt = new Date().toISOString();
  const hold: RampDeliveryMismatch = { reason: verdict.reason, checkedAt };
  if (reportedAmount !== undefined) hold.reportedAmount = reportedAmount;
  if (verdict.observedAmount !== undefined) hold.observedAmount = verdict.observedAmount;
  const held = await repo.holdRampDeliveryMismatch({
    transferId: transfer.id,
    providerSettlement: settled,
    mismatch: { ...hold },
    updatedAt: checkedAt,
  });
  if (!held) return;
  logEvent("error", {
    event: "sdp_api_ramp_delivery_mismatch",
    organization_id: transfer.organization_id,
    project_id: transfer.project_id,
    transfer_id: transfer.id,
    provider: transfer.provider,
    provider_reference: transfer.provider_reference,
    type: transfer.type,
    signature: transfer.signature,
    reason: hold.reason,
    reported_amount: hold.reportedAmount ?? null,
    observed_amount: hold.observedAmount ?? null,
  });
}

/** Whether the provider reported this settlement long enough ago that its transaction should exist. */
function reportedLongAgo(transfer: PaymentTransferRow): boolean {
  const reportedAtMs = Date.parse(transfer.updated_at);
  return (
    Number.isFinite(reportedAtMs) && Date.now() - reportedAtMs > TRANSACTION_NOT_FOUND_AFTER_MS
  );
}

/** The block time as the ISO string the transfer record stores, or null when the RPC had none. */
function blockTimeIso(blockTime: bigint | null | undefined): string | null {
  return blockTime === null || blockTime === undefined
    ? null
    : new Date(Number(blockTime) * 1000).toISOString();
}

async function verifyOnramp(
  env: Env,
  repo: PaymentsRepository,
  chain: RampChainReader,
  transfer: PaymentTransferRow,
  settled: ProviderSettlement
): Promise<boolean> {
  const transactionSignature = signature(settled.onchain?.signature);
  if (!transactionSignature || transactionSignature !== transfer.signature) return false;
  if (!reportedFieldsMatch(transfer, settled)) {
    await holdDelivery(repo, transfer, settled, { reason: "provider_report_mismatch" });
    return false;
  }
  const transaction = await chain.getTransaction(transactionSignature);
  if (!transaction) {
    // An RPC behind on history answers null too, so this stays checked.
    if (reportedLongAgo(transfer) && readDeliveryMismatch(transfer.provider_data) === undefined) {
      await holdDelivery(repo, transfer, settled, { reason: "transaction_not_found" });
    }
    return false;
  }
  const verdict = judgeOnrampDelivery(transfer, settled, transaction);
  if (verdict.kind === "mismatch") {
    await holdDelivery(repo, transfer, settled, verdict);
    return false;
  }
  if (verdict.kind === "pending" || transaction.slot > BigInt(Number.MAX_SAFE_INTEGER)) {
    return false;
  }
  const amount = verdict.amount;
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
      // A delivery the RPC couldn't find before has landed.
      deliveryMismatch: null,
    },
    slot,
    blockTime: blockTimeIso(transaction.blockTime),
    updatedAt: new Date().toISOString(),
  };
  if (transfer.amount === null) update.amount = amount;
  // The completion and its audit row commit together, or the next tick retries both.
  const completed = await auditedRampWriteSystem(
    env,
    "settle",
    (tx) => createSystemTransactionalPaymentsRepository(tx).transitionRampTransfer(update),
    {
      source: "chain",
      fromStatus: transfer.status,
      signature: transactionSignature,
      slot,
      deliveredAmount: amount,
    }
  );
  return completed !== null;
}

async function verifyOfframps(
  env: Env,
  repo: PaymentsRepository,
  chain: RampChainReader,
  transfers: PaymentTransferRow[]
): Promise<string[]> {
  const eligible: Array<{
    transfer: PaymentTransferRow;
    settled: ProviderSettlement;
    submittedSignature: Signature;
  }> = [];
  for (const transfer of transfers) {
    const settled = currentProviderSettlement(transfer);
    const submittedSignature = signature(transfer.signature);
    if (
      !settled ||
      !submittedSignature ||
      !transfer.signed_transaction ||
      !transfer.submission_started_at
    ) {
      continue;
    }
    if (!reportedFieldsMatch(transfer, settled)) {
      await holdDelivery(repo, transfer, settled, { reason: "provider_report_mismatch" });
      continue;
    }
    eligible.push({ transfer, settled, submittedSignature });
  }
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
    if (status?.confirmationStatus !== "finalized") continue;
    if (status.err !== null) {
      await holdDelivery(repo, entry.transfer, entry.settled, { reason: "transaction_failed" });
      continue;
    }
    if (BigInt(status.slot) > BigInt(Number.MAX_SAFE_INTEGER)) continue;
    try {
      const updated = await auditedRampWriteSystem(
        env,
        "settle",
        (tx) =>
          createSystemTransactionalPaymentsRepository(tx).transitionRampTransfer({
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
          }),
        {
          source: "chain",
          fromStatus: entry.transfer.status,
          signature: entry.submittedSignature,
          slot: Number(status.slot),
        }
      );
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
      for (const id of await verifyOfframps(env, repo, chain, offramps)) completed.add(id);
    } catch (error) {
      getLogger().error(
        { environment: currentClusterScope().environment, error },
        "verifyRampDeliveries: off-ramp status read failed"
      );
    }
    for (const transfer of onramps) {
      const settled = currentProviderSettlement(transfer);
      if (!settled) continue;
      try {
        if (await verifyOnramp(env, repo, chain, transfer, settled)) completed.add(transfer.id);
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
