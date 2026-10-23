import { createClusterRpc } from "@sdp/rpc/factory";
import { getSignatureStatuses, getSignaturesForAddress, type SignatureInfo } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { AmountError, parseTokenAmount } from "@sdp/solana/amount";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { type Address, type Signature, signature } from "@solana/kit";
import { ValidateTransferError } from "@solana/pay";
import { z } from "zod";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import {
  type PaymentRequestCheckOutcome,
  type PaymentRequestRow,
  type PaymentRequestsRepository,
  SETTLEMENT_BLOCKED_REASONS,
  type SettlementBlockedReason,
  type SignatureScanPosition,
} from "@/db/repositories/payment-requests.repository";
import {
  generatePaymentTransferId,
  type PaymentsRepository,
  type PaymentTransferRow,
} from "@/db/repositories/payments.repository";
import {
  createPaymentRequestsRepository,
  createTransactionalPaymentRequestsRepository,
  createTransactionalPaymentsRepository,
} from "@/db/repositories/repository-factory";
import { AppError, internalError, rateLimited } from "@/lib/errors";
import { createTenantScope } from "@/lib/tenant-scope";
import { getLogger } from "@/runtime/logger";
import { logEvent } from "@/runtime/money-path-events";
import { createSystemAuditService, type SystemAuditLogEntry } from "@/services/audit.service";
import {
  type PaymentRequestTransferFields,
  validatePaymentRequestTransfer,
} from "@/services/payments/payment-request-transfer";
import { loadPaymentMint, type PaymentMint } from "@/services/payments/token-amount";
import type { Env } from "@/types/env";

const SIGNATURE_PAGE_SIZE = 1000;
const MAX_SIGNATURE_PAGES = 5;
const VERIFY_BUDGET = 25;
const PAYMENT_SEARCH_RETRY_AFTER_SECONDS = 5;
const RETRYABLE_TRANSFER_CHECK_ERRORS: ReadonlySet<string> = new Set([
  "Transaction not found",
  "Transaction meta missing",
]);
const UNREADABLE_SIGNATURE_GIVE_UP_MS = 60 * 60 * 1000;

export function isPaymentRequestExpired(expiresAt: string | null): boolean {
  return expiresAt !== null && Date.parse(expiresAt) <= Date.now();
}

const foundPaymentSchema = z.object({
  signature: z.custom<Signature>(),
  slot: z.bigint(),
  blockTime: z.bigint().nullable(),
});
type FoundPayment = z.infer<typeof foundPaymentSchema>;

const paymentSearchResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("paid"), found: foundPaymentSchema }),
  z.object({ kind: z.literal("pending") }),
  z.object({ kind: z.literal("skipped"), reason: z.enum(SETTLEMENT_BLOCKED_REASONS) }),
  z.object({ kind: z.literal("none") }),
]);
type PaymentSearchResult = z.infer<typeof paymentSearchResultSchema>;

const candidateVerdictSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("paid"), found: foundPaymentSchema }),
  z.object({ kind: z.literal("rejected") }),
  z.object({ kind: z.literal("retry"), reason: z.string() }),
]);
type CandidateVerdict = z.infer<typeof candidateVerdictSchema>;

interface StuckSignature {
  signature: string | null;
  since: string | null;
}

const NOT_STUCK: StuckSignature = { signature: null, since: null };

interface SignatureScanOutcome {
  cursor: Signature | null;
  exhausted: boolean;
  found: FoundPayment | null;
  stuck: StuckSignature;
}

const transferExpectationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("expected"), fields: z.custom<PaymentRequestTransferFields>() }),
  z.object({ kind: z.literal("blocked"), reason: z.enum(SETTLEMENT_BLOCKED_REASONS) }),
]);
type TransferExpectation = z.infer<typeof transferExpectationSchema>;

interface PaidTransition {
  row: PaymentRequestRow;
  from: "awaiting_payment" | "expired" | null;
}

interface PaymentRequestKey {
  requestId: string;
  organizationId: string;
  projectId: string;
}

export async function reconcilePaymentRequest(
  env: Env,
  row: PaymentRequestRow,
  setRetryAfter: (seconds: number) => void
): Promise<PaymentRequestRow> {
  if (row.status !== "awaiting_payment" || isPaymentRequestExpired(row.expires_at)) {
    return row;
  }
  if (row.custody_wallet_id === null) {
    throw new AppError("CONFLICT", "Payment request wallet identity is unresolved");
  }
  const result = await findValidPayment(env, row);
  if (result.kind === "pending") {
    setRetryAfter(PAYMENT_SEARCH_RETRY_AFTER_SECONDS);
    throw rateLimited("A payment to this request may still be confirming; retry shortly");
  }
  if (result.kind === "none" || result.kind === "skipped") {
    return row;
  }
  return settlePaymentRequest(env, row, row.custody_wallet_id, result.found);
}

/** A background check's outcome: the row after it and how the check ended. */
export interface PaymentRequestCheck {
  row: PaymentRequestRow;
  outcome: Exclude<PaymentRequestCheckOutcome, { kind: "failed" }>;
}

function skippedCheck(row: PaymentRequestRow): PaymentRequestCheck {
  return { row, outcome: { kind: "skipped" } };
}

function readCheck(row: PaymentRequestRow): PaymentRequestCheck {
  return { row, outcome: { kind: "read" } };
}

function blockedCheck(
  row: PaymentRequestRow,
  reason: SettlementBlockedReason
): PaymentRequestCheck {
  return { row, outcome: { kind: "blocked", reason } };
}

async function settleIfPaid(
  env: Env,
  row: PaymentRequestRow,
  custodyWalletId: string,
  result: PaymentSearchResult
): Promise<PaymentRequestCheck> {
  switch (result.kind) {
    case "paid":
      return readCheck(await settlePaymentRequest(env, row, custodyWalletId, result.found));
    case "pending":
    case "none":
      return readCheck(row);
    case "skipped":
      return blockedCheck(row, result.reason);
    default: {
      const unreachable: never = result;
      throw internalError(`Unhandled payment search result ${String(unreachable)}`);
    }
  }
}

export async function checkAwaitingPaymentRequest(
  env: Env,
  row: PaymentRequestRow
): Promise<PaymentRequestCheck> {
  if (
    row.status !== "awaiting_payment" ||
    isPaymentRequestExpired(row.expires_at) ||
    row.custody_wallet_id === null
  ) {
    return skippedCheck(row);
  }
  return settleIfPaid(env, row, row.custody_wallet_id, await findValidPayment(env, row));
}

export async function closeLapsedPaymentRequest(
  env: Env,
  row: PaymentRequestRow
): Promise<PaymentRequestCheck> {
  if (row.status !== "awaiting_payment" || !isPaymentRequestExpired(row.expires_at)) {
    return skippedCheck(row);
  }
  if (row.custody_wallet_id === null) {
    return skippedCheck(await markExpired(env, row, false));
  }
  const result = await findValidPayment(env, row);
  switch (result.kind) {
    case "paid":
    case "pending":
      return settleIfPaid(env, row, row.custody_wallet_id, result);
    case "none":
      return readCheck(await markExpired(env, row, true));
    case "skipped":
      return blockedCheck(await markExpired(env, row, false), result.reason);
    default: {
      const unreachable: never = result;
      throw internalError(`Unhandled payment search result ${String(unreachable)}`);
    }
  }
}

export async function checkExpiredPaymentRequestForLatePayment(
  env: Env,
  row: PaymentRequestRow
): Promise<PaymentRequestCheck> {
  if (row.status !== "expired" || row.custody_wallet_id === null) {
    return skippedCheck(row);
  }
  return settleIfPaid(env, row, row.custody_wallet_id, await findValidPayment(env, row));
}

function isPaidLate(blockTime: bigint | null, expiresAt: string | null): boolean {
  if (expiresAt === null) {
    return false;
  }
  return blockTime !== null
    ? Number(blockTime) * 1000 > Date.parse(expiresAt)
    : isPaymentRequestExpired(expiresAt);
}

async function findValidPayment(env: Env, row: PaymentRequestRow): Promise<PaymentSearchResult> {
  const reference = assertValidAddress(row.reference, "reference");
  const expectation = await expectedTransfer(row, reference);
  if (expectation.kind === "blocked") {
    return { kind: "skipped", reason: expectation.reason };
  }
  const expected = expectation.fields;
  const from: SignatureScanPosition = {
    cursor: row.signature_scan_cursor,
    before: row.signature_scan_before,
    stuckSignature: row.signature_scan_stuck_signature,
    stuckSince: row.signature_scan_stuck_since,
  };
  const fetched = await fetchUnscannedSignatures(reference, from);
  const resumeBefore = fetched.newestFirst.at(-2);
  if (fetched.truncated && resumeBefore !== undefined) {
    logEvent("warn", {
      event: "payment_requests.signature_scan_truncated",
      requestId: row.id,
      organizationId: row.organization_id,
      projectId: row.project_id,
      fetched: fetched.newestFirst.length,
      resumed: from.before !== null,
    });
    await advanceSignatureScan(env, row, from, { ...from, before: resumeBefore.signature });
    return { kind: "pending" };
  }
  const scan = await evaluateOldestFirst(row, expected, [...fetched.newestFirst].reverse(), {
    signature: from.stuckSignature,
    since: from.stuckSince,
  });
  await advanceSignatureScan(env, row, from, {
    cursor: scan.cursor ?? from.cursor,
    before: scan.exhausted ? null : from.before,
    stuckSignature: scan.stuck.signature,
    stuckSince: scan.stuck.since,
  });
  if (scan.found !== null) {
    return { kind: "paid", found: scan.found };
  }
  return scan.exhausted && from.before === null ? { kind: "none" } : { kind: "pending" };
}

async function fetchUnscannedSignatures(
  reference: Address,
  from: SignatureScanPosition
): Promise<{ newestFirst: SignatureInfo[]; truncated: boolean }> {
  const until = from.cursor === null ? undefined : signature(from.cursor);
  const newestFirst: SignatureInfo[] = [];
  let before = from.before === null ? undefined : signature(from.before);
  for (let pages = 0; pages < MAX_SIGNATURE_PAGES; pages++) {
    const page = await getSignaturesForAddress(createClusterRpc(), reference, {
      commitment: "confirmed",
      limit: SIGNATURE_PAGE_SIZE,
      until,
      before,
    });
    newestFirst.push(...page);
    const last = page.at(-1);
    if (page.length < SIGNATURE_PAGE_SIZE || last === undefined) {
      return { newestFirst, truncated: false };
    }
    before = last.signature;
  }
  return { newestFirst, truncated: true };
}

async function evaluateOldestFirst(
  row: PaymentRequestRow,
  expected: PaymentRequestTransferFields,
  oldestFirst: readonly SignatureInfo[],
  stuckFrom: StuckSignature
): Promise<SignatureScanOutcome> {
  let cursor: Signature | null = null;
  let contiguous = true;
  let verified = 0;
  let stuck = stuckFrom;
  for (const candidate of oldestFirst) {
    let verdict: CandidateVerdict = { kind: "rejected" };
    if (candidate.err === null) {
      if (verified >= VERIFY_BUDGET) {
        return { cursor, exhausted: false, found: null, stuck };
      }
      verified++;
      verdict = await judgeCandidate(expected, candidate);
    }
    if (verdict.kind === "retry" && contiguous) {
      const stuckSince =
        stuck.signature === candidate.signature && stuck.since !== null
          ? Date.parse(stuck.since)
          : Number.NaN;
      if (Number.isNaN(stuckSince)) {
        stuck = { signature: candidate.signature, since: new Date().toISOString() };
      } else if (Date.now() - stuckSince >= UNREADABLE_SIGNATURE_GIVE_UP_MS) {
        logEvent("warn", {
          event: "payment_requests.signature_unreadable",
          payment_request_id: row.id,
          signature: candidate.signature,
          reason: verdict.reason,
        });
        verdict = { kind: "rejected" };
        stuck = NOT_STUCK;
      }
    } else if (verdict.kind !== "retry" && candidate.signature === stuck.signature) {
      stuck = NOT_STUCK;
    }
    switch (verdict.kind) {
      case "paid":
        return { cursor, exhausted: false, found: verdict.found, stuck: NOT_STUCK };
      case "retry":
        contiguous = false;
        break;
      case "rejected":
        if (contiguous) {
          cursor = candidate.signature;
        }
        break;
      default: {
        const unreachable: never = verdict;
        throw internalError(`Unhandled candidate verdict ${String(unreachable)}`);
      }
    }
  }
  return { cursor, exhausted: contiguous, found: null, stuck };
}

async function judgeCandidate(
  expected: PaymentRequestTransferFields,
  candidate: SignatureInfo
): Promise<CandidateVerdict> {
  const [status] = await getSignatureStatuses(createClusterRpc(), [candidate.signature], {
    searchTransactionHistory: true,
  });
  if (status === null || status === undefined) {
    return { kind: "retry", reason: "not_confirmed" };
  }
  if (status.err !== null) {
    return { kind: "rejected" };
  }
  if (status.confirmationStatus !== "finalized") {
    return { kind: "retry", reason: "not_finalized" };
  }
  let validated: Awaited<ReturnType<typeof validatePaymentRequestTransfer>>;
  try {
    validated = await validatePaymentRequestTransfer(candidate.signature, expected);
  } catch (err) {
    if (!(err instanceof ValidateTransferError)) {
      throw err;
    }
    return RETRYABLE_TRANSFER_CHECK_ERRORS.has(err.message)
      ? { kind: "retry", reason: err.message }
      : { kind: "rejected" };
  }
  return {
    kind: "paid",
    found: {
      signature: candidate.signature,
      slot: candidate.slot,
      blockTime: validated.blockTime ?? candidate.blockTime,
    },
  };
}

async function expectedTransfer(
  row: PaymentRequestRow,
  reference: Address
): Promise<TransferExpectation> {
  let mint: PaymentMint;
  try {
    mint = await loadPaymentMint(assertValidAddress(row.token, "token"));
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "BAD_REQUEST") throw error;
    getLogger().warn(
      { payment_request_id: row.id, reason: "mint_not_admitted", error: error.message },
      "Payment request settlement skipped"
    );
    return { kind: "blocked", reason: "mint_not_admitted" };
  }
  let amount: bigint;
  try {
    amount = parseTokenAmount(row.amount, mint.decimals);
  } catch (error) {
    // Legacy requests may predate create-time precision checks. They must
    // never settle against a rounded or out-of-range amount.
    if (!(error instanceof AmountError)) throw error;
    getLogger().warn(
      { payment_request_id: row.id, reason: "invalid_amount", error: error.message },
      "Payment request settlement skipped"
    );
    return { kind: "blocked", reason: "invalid_amount" };
  }
  const fields: PaymentRequestTransferFields = {
    recipient: assertValidAddress(row.destination_address, "destinationAddress"),
    amount,
    decimals: mint.decimals,
    tokenProgram: mint.tokenProgram,
    reference,
    ...(row.token === SOL_MINT ? {} : { splToken: assertValidAddress(row.token, "token") }),
  };
  return { kind: "expected", fields };
}

async function advanceSignatureScan(
  env: Env,
  row: PaymentRequestRow,
  from: SignatureScanPosition,
  to: SignatureScanPosition
): Promise<void> {
  if (
    from.cursor === to.cursor &&
    from.before === to.before &&
    from.stuckSignature === to.stuckSignature &&
    from.stuckSince === to.stuckSince
  ) {
    return;
  }
  const key = paymentRequestKey(row);
  await createPaymentRequestsRepository(
    env,
    createTenantScope({ organizationId: key.organizationId, projectId: key.projectId })
  ).advanceSignatureScan({ ...key, from, to });
}

async function settlePaymentRequest(
  env: Env,
  row: PaymentRequestRow,
  custodyWalletId: string,
  found: FoundPayment
): Promise<PaymentRequestRow> {
  const key = paymentRequestKey(row);
  const scope = createTenantScope({ organizationId: key.organizationId, projectId: key.projectId });
  const paidLate = isPaidLate(found.blockTime, row.expires_at);
  const audit = createSystemAuditService(env);
  const settle = () =>
    audit.logSystemWithin(async (db) => {
      const transfer = await recordInboundTransfer(
        createTransactionalPaymentsRepository(db, scope),
        row,
        key.projectId,
        custodyWalletId,
        found
      );
      const transition = await transitionToPaid(
        createTransactionalPaymentRequestsRepository(db, scope),
        row,
        key,
        transfer.id,
        paidLate
      );
      return {
        entry: transition.from === null ? null : settlementAuditEntry(transition, transfer, found),
        result: transition.row,
      };
    });
  try {
    return await settle();
  } catch (err) {
    if (!isPostgresUniqueViolation(err)) {
      throw err;
    }
    return settle();
  }
}

async function transitionToPaid(
  requestsRepo: PaymentRequestsRepository,
  row: PaymentRequestRow,
  key: PaymentRequestKey,
  transferId: string,
  paidLate: boolean
): Promise<PaidTransition> {
  const paid = { ...key, fulfilledByTransferId: transferId, paidLate };
  if (row.status === "awaiting_payment") {
    const settled = await requestsRepo.markPaymentRequest({
      ...paid,
      status: "paid",
      canceledBy: null,
      chainRead: true,
    });
    if (settled) {
      return { row: settled, from: "awaiting_payment" };
    }
  }
  const current = await reread(requestsRepo, key);
  if (current.status !== "expired") {
    return { row: current, from: null };
  }
  const converted = await requestsRepo.markExpiredPaymentRequestPaid(paid);
  return converted
    ? { row: converted, from: "expired" }
    : { row: await reread(requestsRepo, key), from: null };
}

function settlementAuditEntry(
  transition: PaidTransition,
  transfer: PaymentTransferRow,
  found: FoundPayment
): SystemAuditLogEntry {
  return {
    organizationId: transition.row.organization_id,
    action: "settle",
    resourceType: "payment_request",
    resourceId: transition.row.id,
    metadata: {
      projectId: transition.row.project_id,
      fromStatus: transition.from,
      paidLate: transition.row.paid_late,
      transferId: transfer.id,
      signature: found.signature,
      slot: found.slot.toString(),
      blockTime: found.blockTime?.toString() ?? null,
      amount: transition.row.amount,
      tokenMint: transition.row.token,
      destination: transition.row.destination_address,
      walletId: transition.row.wallet_id,
    },
  };
}

async function markExpired(
  env: Env,
  row: PaymentRequestRow,
  chainRead: boolean
): Promise<PaymentRequestRow> {
  const key = paymentRequestKey(row);
  const scope = createTenantScope({ organizationId: key.organizationId, projectId: key.projectId });
  return createSystemAuditService(env).logSystemWithin(async (db) => {
    const requestsRepo = createTransactionalPaymentRequestsRepository(db, scope);
    const expired = await requestsRepo.markPaymentRequest({
      ...key,
      status: "expired",
      fulfilledByTransferId: null,
      canceledBy: null,
      paidLate: false,
      chainRead,
    });
    return {
      entry: expired === null ? null : expiryAuditEntry(expired),
      result: expired ?? (await reread(requestsRepo, key)),
    };
  });
}

function expiryAuditEntry(expired: PaymentRequestRow): SystemAuditLogEntry {
  return {
    organizationId: expired.organization_id,
    action: "update",
    resourceType: "payment_request",
    resourceId: expired.id,
    metadata: {
      projectId: expired.project_id,
      fromStatus: "awaiting_payment",
      toStatus: "expired",
      expiresAt: expired.expires_at,
      amount: expired.amount,
      tokenMint: expired.token,
      destination: expired.destination_address,
      walletId: expired.wallet_id,
    },
  };
}

async function reread(
  requestsRepo: PaymentRequestsRepository,
  key: PaymentRequestKey
): Promise<PaymentRequestRow> {
  const current = await requestsRepo.getPaymentRequestById(key);
  if (!current) {
    throw internalError("payment request not found after settlement");
  }
  return current;
}

function paymentRequestKey(row: PaymentRequestRow): PaymentRequestKey {
  return { requestId: row.id, organizationId: row.organization_id, projectId: row.project_id };
}

async function recordInboundTransfer(
  paymentsRepo: PaymentsRepository,
  row: PaymentRequestRow,
  projectId: string,
  custodyWalletId: string,
  found: FoundPayment
): Promise<PaymentTransferRow> {
  const [existing] = await paymentsRepo.listTransfersBySignatures({
    signatures: [found.signature],
    organizationId: row.organization_id,
    projectId,
  });
  if (existing) {
    if (
      existing.custody_wallet_id !== row.custody_wallet_id ||
      existing.wallet_id !== row.wallet_id ||
      existing.destination_address !== row.destination_address ||
      existing.token !== row.token ||
      existing.amount !== row.amount ||
      existing.type !== "transfer" ||
      existing.direction !== "inbound"
    ) {
      throw new AppError("CONFLICT", "Recorded transfer does not match payment request");
    }
    const finalized = await paymentsRepo.updateTransfer({
      transferId: existing.id,
      organizationId: row.organization_id,
      projectId,
      expectedStatus: "confirmed",
      status: "finalized",
      slot: Number(found.slot),
      updatedAt: new Date().toISOString(),
    });
    return finalized ?? existing;
  }
  const transfer = await paymentsRepo.createTransfer({
    id: generatePaymentTransferId(),
    organizationId: row.organization_id,
    projectId,
    custodyWalletId,
    walletId: row.wallet_id,
    counterpartyId: null,
    sourceAddress: null,
    destinationAddress: row.destination_address,
    token: row.token,
    amount: row.amount,
    memo: null,
    type: "transfer",
    direction: "inbound",
    status: "finalized",
    provider: null,
    providerReference: null,
    deliveryMode: null,
    fiatCurrency: null,
    fiatAmount: null,
    providerData: {},
    serializedTx: null,
    signature: found.signature,
    slot: Number(found.slot),
    initiatedByKeyId: null,
  });
  if (!transfer) {
    throw internalError("Failed to record inbound transfer for payment request settlement");
  }
  return transfer;
}
