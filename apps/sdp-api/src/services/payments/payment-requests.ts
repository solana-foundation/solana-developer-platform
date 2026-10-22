import { createClusterRpc } from "@sdp/rpc/factory";
import { getSignaturesForAddress, type SignatureInfo, type SolanaRpc } from "@sdp/rpc/solana";
import { verifyTransactionLanded } from "@sdp/rpc/verified-confirmation";
import { assertValidAddress } from "@sdp/solana/address";
import { toNumberAmount } from "@sdp/solana/amount";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { type Address, type Signature, signature } from "@solana/kit";
import { ValidateTransferError, validateTransfer } from "@solana/pay";
import { z } from "zod";
import { asTransactionalClient, getDb } from "@/db/client";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import type {
  PaymentRequestRow,
  PaymentRequestsRepository,
  SignatureScanPosition,
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
import { logEvent } from "@/runtime/money-path-events";
import type { Env } from "@/types/env";

const SIGNATURE_PAGE_SIZE = 1000;
const MAX_SIGNATURE_PAGES = 5;
const VERIFY_BUDGET = 25;
const PAYMENT_SEARCH_RETRY_AFTER_SECONDS = 5;
const RETRYABLE_TRANSFER_CHECK_ERRORS: ReadonlySet<string> = new Set(["not found", "missing meta"]);
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
  z.object({ kind: z.literal("none") }),
]);
type PaymentSearchResult = z.infer<typeof paymentSearchResultSchema>;

const candidateVerdictSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("paid"), found: foundPaymentSchema }),
  z.object({ kind: z.literal("rejected") }),
  z.object({ kind: z.literal("retry"), reason: z.string() }),
]);
type CandidateVerdict = z.infer<typeof candidateVerdictSchema>;

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
  const result = await findValidPayment(env, createClusterRpc(), row);
  if (result.kind === "pending") {
    setRetryAfter(PAYMENT_SEARCH_RETRY_AFTER_SECONDS);
    throw rateLimited("A payment to this request may still be confirming; retry shortly");
  }
  if (result.kind === "none") {
    return row;
  }
  return settlePaymentRequest(env, row, row.custody_wallet_id, result.found);
}

export async function checkAwaitingPaymentRequest(
  env: Env,
  row: PaymentRequestRow
): Promise<PaymentRequestRow> {
  if (
    row.status !== "awaiting_payment" ||
    isPaymentRequestExpired(row.expires_at) ||
    row.custody_wallet_id === null
  ) {
    return row;
  }
  const result = await findValidPayment(env, createClusterRpc(), row);
  if (result.kind !== "paid") {
    return row;
  }
  return settlePaymentRequest(env, row, row.custody_wallet_id, result.found);
}

export async function closeLapsedPaymentRequest(
  env: Env,
  row: PaymentRequestRow
): Promise<PaymentRequestRow> {
  if (row.status !== "awaiting_payment" || !isPaymentRequestExpired(row.expires_at)) {
    return row;
  }
  if (row.custody_wallet_id !== null) {
    const result = await findValidPayment(env, createClusterRpc(), row);
    if (result.kind === "paid") {
      return settlePaymentRequest(env, row, row.custody_wallet_id, result.found);
    }
    if (result.kind === "pending") {
      return row;
    }
  }
  return markExpired(env, row);
}

export async function checkExpiredPaymentRequestForLatePayment(
  env: Env,
  row: PaymentRequestRow
): Promise<PaymentRequestRow> {
  if (row.status !== "expired" || row.custody_wallet_id === null) {
    return row;
  }
  const result = await findValidPayment(env, createClusterRpc(), row);
  if (result.kind !== "paid") {
    return row;
  }
  return settlePaymentRequest(env, row, row.custody_wallet_id, result.found);
}

function isPaidLate(blockTime: bigint | null, expiresAt: string | null): boolean {
  if (expiresAt === null) {
    return false;
  }
  return blockTime !== null
    ? Number(blockTime) * 1000 > Date.parse(expiresAt)
    : isPaymentRequestExpired(expiresAt);
}

async function findValidPayment(
  env: Env,
  rpc: SolanaRpc,
  row: PaymentRequestRow
): Promise<PaymentSearchResult> {
  const reference = assertValidAddress(row.reference, "reference");
  const from: SignatureScanPosition = {
    cursor: row.signature_scan_cursor,
    before: row.signature_scan_before,
  };
  const fetched = await fetchUnscannedSignatures(rpc, reference, from);
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
    await advanceSignatureScan(env, row, from, {
      cursor: from.cursor,
      before: resumeBefore.signature,
    });
    return { kind: "pending" };
  }
  const scan = await evaluateOldestFirst(rpc, row, reference, [...fetched.newestFirst].reverse());
  await advanceSignatureScan(env, row, from, {
    cursor: scan.cursor ?? from.cursor,
    before: scan.exhausted ? null : from.before,
  });
  if (scan.found !== null) {
    return { kind: "paid", found: scan.found };
  }
  return scan.exhausted && from.before === null ? { kind: "none" } : { kind: "pending" };
}

async function fetchUnscannedSignatures(
  rpc: SolanaRpc,
  reference: Address,
  from: SignatureScanPosition
): Promise<{ newestFirst: SignatureInfo[]; truncated: boolean }> {
  const until = from.cursor === null ? undefined : signature(from.cursor);
  const newestFirst: SignatureInfo[] = [];
  let before = from.before === null ? undefined : signature(from.before);
  for (let pages = 0; pages < MAX_SIGNATURE_PAGES; pages++) {
    const page = await getSignaturesForAddress(rpc, reference, {
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
  rpc: SolanaRpc,
  row: PaymentRequestRow,
  reference: Address,
  oldestFirst: readonly SignatureInfo[]
): Promise<{ cursor: Signature | null; exhausted: boolean; found: FoundPayment | null }> {
  let cursor: Signature | null = null;
  let contiguous = true;
  let verified = 0;
  for (const candidate of oldestFirst) {
    let verdict: CandidateVerdict = { kind: "rejected" };
    if (candidate.err === null) {
      if (verified >= VERIFY_BUDGET) {
        return { cursor, exhausted: false, found: null };
      }
      verified++;
      verdict = await judgeCandidate(rpc, row, reference, candidate);
    }
    if (verdict.kind === "retry" && isPastUnreadableGiveUp(candidate.blockTime)) {
      logEvent("warn", {
        event: "payment_requests.signature_unreadable",
        payment_request_id: row.id,
        signature: candidate.signature,
        reason: verdict.reason,
      });
      verdict = { kind: "rejected" };
    }
    if (verdict.kind === "paid") {
      return { cursor, exhausted: false, found: verdict.found };
    }
    if (verdict.kind === "retry") {
      contiguous = false;
    } else if (contiguous) {
      cursor = candidate.signature;
    }
  }
  return { cursor, exhausted: contiguous, found: null };
}

function isPastUnreadableGiveUp(blockTime: bigint | null): boolean {
  return (
    blockTime !== null && Date.now() - Number(blockTime) * 1000 > UNREADABLE_SIGNATURE_GIVE_UP_MS
  );
}

async function judgeCandidate(
  rpc: SolanaRpc,
  row: PaymentRequestRow,
  reference: Address,
  candidate: SignatureInfo
): Promise<CandidateVerdict> {
  const landed = await verifyTransactionLanded(rpc, candidate.signature, {
    searchTransactionHistory: true,
  });
  if (!landed.ok) {
    return landed.reason === "failed" || landed.reason === "account_missing"
      ? { kind: "rejected" }
      : { kind: "retry", reason: landed.reason };
  }
  try {
    await validateTransfer(rpc, candidate.signature, {
      recipient: assertValidAddress(row.destination_address, "destinationAddress"),
      amount: toNumberAmount(row.amount),
      reference,
      splToken: row.token === SOL_MINT ? undefined : assertValidAddress(row.token, "token"),
    });
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
      blockTime: candidate.blockTime ?? landed.transaction.blockTime ?? null,
    },
  };
}

async function advanceSignatureScan(
  env: Env,
  row: PaymentRequestRow,
  from: SignatureScanPosition,
  to: SignatureScanPosition
): Promise<void> {
  if (from.cursor === to.cursor && from.before === to.before) {
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
  const settle = () =>
    getDb(env).transaction(async (tx) => {
      const db = asTransactionalClient(tx);
      const transfer = await recordInboundTransfer(
        createTransactionalPaymentsRepository(db, scope),
        row,
        key.projectId,
        custodyWalletId,
        found
      );
      return transitionToPaid(
        createTransactionalPaymentRequestsRepository(db, scope),
        row,
        key,
        transfer.id,
        paidLate
      );
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
): Promise<PaymentRequestRow> {
  const paid = { ...key, fulfilledByTransferId: transferId, paidLate };
  if (row.status === "awaiting_payment") {
    const settled = await requestsRepo.markPaymentRequest({
      ...paid,
      status: "paid",
      canceledBy: null,
    });
    if (settled) {
      return settled;
    }
  }
  const current = await reread(requestsRepo, key);
  if (current.status !== "expired") {
    return current;
  }
  return (
    (await requestsRepo.markExpiredPaymentRequestPaid(paid)) ?? (await reread(requestsRepo, key))
  );
}

async function markExpired(env: Env, row: PaymentRequestRow): Promise<PaymentRequestRow> {
  const key = paymentRequestKey(row);
  const requestsRepo = createPaymentRequestsRepository(
    env,
    createTenantScope({ organizationId: key.organizationId, projectId: key.projectId })
  );
  const expired = await requestsRepo.markPaymentRequest({
    ...key,
    status: "expired",
    fulfilledByTransferId: null,
    canceledBy: null,
    paidLate: false,
  });
  return expired ?? (await reread(requestsRepo, key));
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
    return existing;
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
    status: "confirmed",
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
