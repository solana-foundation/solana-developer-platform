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
import { compareDecimalAmounts, formatDecimalAmount, parseDecimalAmount } from "@sdp/solana/amount";
import { type AssetRef, NATIVE_ASSET } from "@sdp/solana/asset-ref";
import { baseUnits } from "@sdp/solana/token-amount";
import { feeFor, type TokenTerms } from "@sdp/solana/token-terms";
import type { RampDeliveryMismatch, RampDeliveryMismatchReason } from "@sdp/types/payments";
import { type AmountVerificationVerdict, MOVEMENT_NOT_EXECUTED } from "@sdp/types/token-movements";
import {
  SOL_DECIMALS,
  SOL_MINT,
  SPL_TOKEN_PROGRAMS,
  WELL_KNOWN_TOKEN_BY_MINT,
} from "@sdp/types/well-known-tokens";
import { address, assertIsSignature, type Epoch, type Signature, unixTimestamp } from "@solana/kit";
import { z } from "zod";
import type { PaymentsRepository, PaymentTransferRow } from "@/db/repositories/payments.repository";
import {
  createSystemPaymentsRepository,
  createSystemTransactionalPaymentsRepository,
} from "@/db/repositories/repository-factory";
import type { ChainVerifiedLeg } from "@/db/repositories/token-movement-legs.repository";
import { getLogger } from "@/runtime/logger";
import { logEvent } from "@/runtime/money-path-events";
import { auditedRampWriteSystem } from "@/services/payments/ramp-audit";
import {
  currentProviderSettlement,
  type ProviderSettlement,
  readDeliveryMismatch,
} from "@/services/payments/ramp-provider-settlement";
import { readTokenTerms } from "@/services/token-movement/read-terms";
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
  /** A mint's Token Terms, read live: only when a delivery's debit and credit differ. */
  readTokenTerms(asset: Extract<AssetRef, { kind: "token" }>): Promise<TokenTerms>;
  /** The epoch `slot` is in, from the cluster's epoch schedule (read once per process). */
  epochOfSlot(slot: bigint): Promise<Epoch>;
}

type EpochSchedule = Awaited<ReturnType<ReturnType<SolanaRpc["getEpochSchedule"]>["send"]>>;

/** Each cluster's epoch schedule, a static fact; a failed read is never kept. */
const epochSchedules = new Map<string, Promise<EpochSchedule>>();

function clusterEpochSchedule(rpc: SolanaRpc): Promise<EpochSchedule> {
  const { cluster } = currentClusterScope();
  const cached = epochSchedules.get(cluster);
  if (cached !== undefined) {
    return cached;
  }
  const read = rpc.getEpochSchedule().send();
  epochSchedules.set(cluster, read);
  read.catch(() => epochSchedules.delete(cluster));
  return read;
}

/**
 * The epoch `slot` is in, as `EpochSchedule::get_epoch` computes it: warmup
 * epochs double from the minimum length until `firstNormalSlot`, then every
 * epoch is `slotsPerEpoch` long.
 */
export function epochAt(
  schedule: Pick<EpochSchedule, "firstNormalEpoch" | "firstNormalSlot" | "slotsPerEpoch">,
  slot: bigint
): Epoch {
  if (slot >= schedule.firstNormalSlot) {
    return schedule.firstNormalEpoch + (slot - schedule.firstNormalSlot) / schedule.slotsPerEpoch;
  }
  let epoch = 0n;
  let length = MINIMUM_SLOTS_PER_EPOCH;
  let start = 0n;
  while (slot >= start + length) {
    start += length;
    length *= 2n;
    epoch += 1n;
  }
  return epoch;
}

function createRampChainReader(rpc: SolanaRpc = createClusterRpc()): RampChainReader {
  return {
    getTransaction: (signature) => getTransaction(rpc, signature, "finalized"),
    getSignatureStatuses: (signatures) =>
      getSignatureStatuses(rpc, signatures, { searchTransactionHistory: true }),
    readTokenTerms: (asset) => readTokenTerms(asset),
    epochOfSlot: async (slot) => epochAt(await clusterEpochSchedule(rpc), slot),
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
      // Both are token units; they compare exactly, at no assumed scale.
      try {
        const token = WELL_KNOWN_TOKEN_BY_MINT.get(transfer.token);
        if (
          !token?.clusters.includes(currentClusterScope().cluster) ||
          compareDecimalAmounts(onchain.amount, transfer.amount) !== 0
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

/** Whether a mint's fee rule explains a delivery's debit and credit differing. */
type FeeRuleVerdict = "explained" | "unexplained" | "unknown";

/** `MINIMUM_SLOTS_PER_EPOCH`: the first warmup epoch's length. */
const MINIMUM_SLOTS_PER_EPOCH = 32n;

/** What one read of a finalized transaction proves about a provider-reported delivery. */
type DeliveryVerdict =
  | { kind: "verified"; amount: string; leg: ChainVerifiedLeg }
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

/**
 * The asset an on-ramp delivers, or null when its token is no catalogue asset
 * on this cluster. Rows store native SOL under the wrapped SOL mint
 * (`normalizePaymentToken`), and providers deliver SOL natively, so that mint
 * on a ramp row is native SOL; every other token is its catalogue mint.
 */
function rampDeliveryAsset(transfer: PaymentTransferRow): AssetRef | null {
  if (transfer.token === SOL_MINT) {
    return NATIVE_ASSET;
  }
  const token = WELL_KNOWN_TOKEN_BY_MINT.get(transfer.token);
  if (!token?.clusters.includes(currentClusterScope().cluster)) {
    return null;
  }
  return { kind: "token", mint: address(transfer.token), program: token.tokenProgram };
}

/** What the chain shows a delivery moved into its destination, in base units. */
interface ObservedDelivery {
  decimals: number;
  /** The destination's balance change: what it received. */
  credit: bigint;
  /** What the transfers into the destination debited, by their instruction data. */
  debit: bigint;
  /** Each transfer's own debit: a fee is charged, capped and rounded per transfer. */
  debits: readonly bigint[];
  /** The fee the transfers stated (TransferCheckedWithFee); null when one stated none. */
  statedFee: bigint | null;
}

const TOKEN_TRANSFER_TYPES: ReadonlySet<string> = new Set([
  "transfer",
  "transferChecked",
  "transferCheckedWithFee",
]);

const rawTokenAmountSchema = z.object({ amount: z.string().regex(/^\d+$/) });

/**
 * A parsed instruction's raw amount at `key` (`tokenAmount.amount` or
 * `feeAmount.amount`), or the flat `amount` an unchecked `transfer` carries.
 */
function rawAmountOf(
  info: Record<string, unknown>,
  key: "tokenAmount" | "feeAmount"
): bigint | null {
  const nested = rawTokenAmountSchema.safeParse(info[key]);
  if (nested.success) return BigInt(nested.data.amount);
  if (key === "feeAmount") return null;
  const flat = rawTokenAmountSchema.safeParse(info);
  return flat.success ? BigInt(flat.data.amount) : null;
}

/**
 * The asset's movement into `destination`: "absent" when the transaction moved
 * none, null when it cannot be read. Base units only: a token's credit is the
 * owner's raw balance change at the mint's own decimals as the chain reports
 * them (`tokenBalanceDelta`), never a display value or a catalogue scale, and
 * its debit is the instruction data of the transfers into the owner's token
 * accounts of the mint.
 */
function observedDelivery(
  asset: AssetRef,
  destination: string,
  transaction: ParsedTransaction
): ObservedDelivery | "absent" | null {
  if (asset.kind === "native") {
    const index = transaction.accountKeys.indexOf(destination);
    if (index < 0) return "absent";
    const pre = transaction.preBalances?.[index];
    const post = transaction.postBalances?.[index];
    if (pre === undefined || post === undefined) return null;
    // A native delivery carries no transfer fee.
    return {
      decimals: SOL_DECIMALS,
      credit: post - pre,
      debit: post - pre,
      debits: [post - pre],
      statedFee: 0n,
    };
  }
  if (transaction.preTokenBalances === undefined || transaction.postTokenBalances === undefined) {
    return null;
  }
  const delta = tokenBalanceDelta(transaction, { mint: asset.mint, owner: destination });
  if (delta === null) return "absent";

  const destinationAccounts = new Set(
    [...transaction.preTokenBalances, ...transaction.postTokenBalances]
      .filter((balance) => balance.mint === asset.mint && balance.owner === destination)
      .map((balance) => transaction.accountKeys[balance.accountIndex])
  );
  let debit = 0n;
  const debits: bigint[] = [];
  let statedFee: bigint | null = 0n;
  let moves = 0;
  const tokenProgram = SPL_TOKEN_PROGRAMS[asset.program];
  for (const instruction of transaction.instructions) {
    // The System program's "transfer" moves lamports, as when the ATA program
    // tops up rent for an account that already held some: only the mint's own
    // token program moves its tokens.
    if (
      instruction.programId !== tokenProgram ||
      instruction.parsedType === null ||
      !TOKEN_TRANSFER_TYPES.has(instruction.parsedType) ||
      instruction.info === null ||
      !destinationAccounts.has(String(instruction.info.destination))
    ) {
      continue;
    }
    const amount = rawAmountOf(instruction.info, "tokenAmount");
    if (amount === null) return null;
    debit += amount;
    debits.push(amount);
    moves += 1;
    const fee =
      instruction.parsedType === "transferCheckedWithFee"
        ? rawAmountOf(instruction.info, "feeAmount")
        : null;
    statedFee = statedFee === null || fee === null ? null : statedFee + fee;
  }
  // A delivery by an instruction this reader does not parse (a CPI it cannot
  // attribute) is judged by its credit alone.
  return moves === 0 || debit < delta.baseUnits
    ? {
        decimals: delta.decimals,
        credit: delta.baseUnits,
        debit: delta.baseUnits,
        debits: [delta.baseUnits],
        statedFee: 0n,
      }
    : { decimals: delta.decimals, credit: delta.baseUnits, debit, debits, statedFee };
}

/**
 * Whether the transfer fee rule explains a delivery's debit and credit
 * differing: the program checked a fee the transfers stated, or the mint's fee
 * entry in force in the epoch the delivery landed, read live, charges exactly
 * that fee, summed over the transfers (each is capped and rounded on its own).
 * `unknown` when both fee entries the mint keeps came after the delivery: the
 * fee it paid is no longer on chain, which is no contradiction. Reads the mint
 * and the epoch only when a fee is not stated.
 */
async function feeRuleExplains(
  asset: AssetRef,
  delivery: ObservedDelivery,
  landedSlot: bigint,
  chain: Pick<RampChainReader, "readTokenTerms" | "epochOfSlot">
): Promise<FeeRuleVerdict> {
  const fee = delivery.debit - delivery.credit;
  if (fee === 0n) return "explained";
  if (asset.kind !== "token") return "unexplained";
  if (delivery.statedFee !== null) {
    return delivery.statedFee === fee ? "explained" : "unexplained";
  }
  const terms = await chain.readTokenTerms(asset);
  if (terms.transferFee === null) return "unexplained";
  const epoch = await chain.epochOfSlot(landedSlot);
  if (epoch < terms.transferFee.older.epoch) return "unknown";
  const charged = delivery.debits.reduce(
    (total, debit) => total + feeFor(terms, baseUnits(debit), epoch),
    0n
  );
  return charged === fee ? "explained" : "unexplained";
}

async function judgeOnrampDelivery(
  transfer: PaymentTransferRow,
  settled: ProviderSettlement,
  transaction: ParsedTransaction,
  chain: Pick<RampChainReader, "readTokenTerms" | "epochOfSlot">
): Promise<DeliveryVerdict> {
  const destination = transfer.destination_address;
  const asset = rampDeliveryAsset(transfer);
  if (!destination || asset === null || !transaction.executionResultKnown) {
    return PENDING;
  }
  if (transaction.err !== null) return mismatch("transaction_failed");
  const landed = landedAfterTransfer(transfer, transaction);
  if (landed === null || transaction.blockTime === null || transaction.blockTime === undefined) {
    return PENDING;
  }
  if (!landed) return mismatch("predates_transfer");
  const delivery = observedDelivery(asset, destination, transaction);
  if (delivery === null) return PENDING;
  if (delivery === "absent" || delivery.credit <= 0n) return mismatch("not_delivered");
  const { decimals } = delivery;
  const observedAmount = formatDecimalAmount(delivery.credit, decimals);
  // A provider may report what it received (the credit) or what it sent (the
  // debit): the debit counts only when the fee rule explains the difference.
  const feeRule =
    delivery.debit === delivery.credit
      ? "explained"
      : await feeRuleExplains(asset, delivery, transaction.slot, chain);
  const debitCounts = delivery.debit !== delivery.credit && feeRule === "explained";
  try {
    const reported = [settled.receivedAmount, settled.onchain?.amount].filter(
      (amount): amount is string => amount !== undefined
    );
    const quoted = transfer.amount === null ? null : parseDecimalAmount(transfer.amount, decimals);
    /** Whether the reports and the quote hold, counting the debit or not. */
    const holds = (countDebit: boolean) =>
      reported.every((amount) => {
        const units = parseDecimalAmount(amount, decimals);
        return units === delivery.credit || (countDebit && units === delivery.debit);
      }) &&
      !(quoted !== null && delivery.credit < quoted && !(countDebit && delivery.debit >= quoted));
    if (!holds(debitCounts)) {
      // The fee that applied is no longer on chain: when counting the debit
      // would settle it, read again later rather than record a contradiction
      // the chain cannot support. Anything else no fee could explain.
      return feeRule === "unknown" && holds(true)
        ? PENDING
        : mismatch("amount_mismatch", observedAmount);
    }
  } catch {
    return mismatch("amount_mismatch", observedAmount);
  }
  const amounts = {
    debit: baseUnits(debitCounts ? delivery.debit : delivery.credit),
    fee: baseUnits(debitCounts ? delivery.debit - delivery.credit : 0n),
    credit: baseUnits(delivery.credit),
  };
  return {
    kind: "verified",
    amount: observedAmount,
    leg: {
      quote: {
        asset,
        decimals,
        // A provider's delivery amount is a receipt.
        basis: "credit",
        quoted: amounts,
        // No terms read prices the fee: it is what the chain shows.
        feeEpoch: null,
        asOf:
          asset.kind === "native"
            ? null
            : { slot: transaction.slot, unixTimestamp: unixTimestamp(transaction.blockTime) },
        displayRule: null,
      },
      observed: amounts,
    },
  };
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
  verdict: { reason: RampDeliveryMismatchReason; observedAmount?: string },
  legVerdict: AmountVerificationVerdict | null
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
    legVerdict,
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
    await holdDelivery(repo, transfer, settled, { reason: "provider_report_mismatch" }, null);
    return false;
  }
  const transaction = await chain.getTransaction(transactionSignature);
  if (!transaction) {
    // An RPC behind on history answers null too, so this stays checked.
    if (reportedLongAgo(transfer) && readDeliveryMismatch(transfer.provider_data) === undefined) {
      await holdDelivery(repo, transfer, settled, { reason: "transaction_not_found" }, null);
    }
    return false;
  }
  const verdict = await judgeOnrampDelivery(transfer, settled, transaction, chain);
  if (verdict.kind === "mismatch") {
    // An on-ramp is provider-built: it has no leg until its delivery verifies.
    await holdDelivery(repo, transfer, settled, verdict, null);
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
    // The delivery's leg: what the chain shows the provider moved, verified.
    chainVerifiedLeg: verdict.leg,
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
      await holdDelivery(repo, transfer, settled, { reason: "provider_report_mismatch" }, null);
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
      // The deposit SDP built failed on chain, so it moved nothing.
      await holdDelivery(
        repo,
        entry.transfer,
        entry.settled,
        { reason: "transaction_failed" },
        MOVEMENT_NOT_EXECUTED
      );
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
