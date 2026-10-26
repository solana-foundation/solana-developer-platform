import { createClusterRpc } from "@sdp/rpc/factory";
import {
  getSignatureStatuses,
  getSignaturesForAddress,
  type SignatureInfo,
  type SolanaRpc,
} from "@sdp/rpc/solana";
import { withTransientRpcRetry } from "@sdp/rpc/transient";
import { assertValidAddress } from "@sdp/solana/address";
import { AmountError } from "@sdp/solana/amount";
import { type AssetRef, type AssetRequest, isSameAsset, NATIVE_ASSET } from "@sdp/solana/asset-ref";
import {
  type BaseUnits,
  parseTokenAmount,
  toBaseUnits,
  toTokenAmount,
} from "@sdp/solana/token-amount";
import { support, TOKEN_MOVEMENT_REFUSALS } from "@sdp/solana/token-movement";
import type { FinalPaymentRequestTransactionOutcome } from "@sdp/types/payments";
import { BUILT_MOVEMENT_VERDICTS, type TokenMovementExpectation } from "@sdp/types/token-movements";
import { SPL_TOKEN_PROGRAMS } from "@sdp/types/well-known-tokens";
import {
  type Address,
  address,
  commitmentComparator,
  type Signature,
  signature,
} from "@solana/kit";
import { ValidateTransferError } from "@solana/pay";
import { z } from "zod";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import {
  type PaymentRequestCheckOutcome,
  type PaymentRequestExpectation,
  type PaymentRequestRow,
  type PaymentRequestsRepository,
  SETTLEMENT_BLOCKED_REASONS,
  type SettlementBlockedReason,
  type SignatureScanPosition,
  type SignedPaymentRequestTransaction,
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
import {
  createPostgresTokenMovementLegsRepository,
  type TokenMovementLegsRepository,
} from "@/db/repositories/token-movement-legs.repository";
import { AppError, badRequest, internalError, rateLimited } from "@/lib/errors";
import { createTenantScope } from "@/lib/tenant-scope";
import { getLogger } from "@/runtime/logger";
import { logEvent } from "@/runtime/money-path-events";
import { createSystemAuditService, type SystemAuditLogEntry } from "@/services/audit.service";
import { isNativePaymentToken, resolvePaymentAsset } from "@/services/payment-operation.service";
import {
  type PaymentRequestTransferFields,
  validatePaymentRequestTransfer,
} from "@/services/payments/payment-request-transfer";
import type { PlannedTokenMovement } from "@/services/token-movement/build";
import { readTokenTerms } from "@/services/token-movement/read-terms";
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
/**
 * About how long a blockhash lives: 150 blocks at 400 ms. A younger window has
 * most likely not lapsed, so its check reads no chain tip and it stays open
 * for a later check. Only the read is skipped: whether a window lapsed is
 * always proven by the chain.
 */
const BLOCKHASH_LIFETIME_MS = 60_000;
/** `getSignatureStatuses` takes at most this many signatures. */
const MAX_SIGNATURES_PER_STATUS_READ = 256;

export function isPaymentRequestExpired(expiresAt: string | null): boolean {
  return expiresAt !== null && Date.parse(expiresAt) <= Date.now();
}

/**
 * The asset a payment request's token names. A request names a mint address,
 * and the wrapped SOL mint has always meant native SOL here (a system
 * transfer), so it stays native; every other mint resolves as Payments
 * resolves it. The stored expectation records the asset, so a row no longer
 * leaves it to the token string.
 */
export function paymentRequestAsset(token: string): AssetRequest {
  return isNativePaymentToken(token) ? NATIVE_ASSET : resolvePaymentAsset(token);
}

/** A request's expectation, or why its token and amount cannot make one. */
type ExpectationRead =
  | { kind: "expected"; expectation: PaymentRequestExpectation }
  | { kind: "refused"; reason: SettlementBlockedReason; error: AppError };

/**
 * Reads what a request of `amount` in `token` expects: its asset, resolved,
 * and the amount as a credit in base units at the decimals the mint has now.
 *
 * RPC budget: one terms read (`getMultipleAccounts` of the mint and the
 * Clock); native SOL none.
 *
 * @param settling - The read verifies a payment that may have landed, not a new
 *   transfer: a paused mint is no reason to skip it, because the pause cannot
 *   undo a payment that already landed.
 */
async function readPaymentRequestExpectation(
  token: string,
  amount: string,
  settling = false
): Promise<ExpectationRead> {
  const terms = await readTokenTerms(paymentRequestAsset(token));
  const decision = support(terms, "builder");
  if (!decision.supported && !(settling && decision.refusal === TOKEN_MOVEMENT_REFUSALS.paused)) {
    return {
      kind: "refused",
      reason: "mint_not_admitted",
      error: badRequest(decision.message, { reason: decision.refusal }),
    };
  }
  let credit: BaseUnits;
  try {
    credit = toBaseUnits(parseTokenAmount(amount, terms.decimals));
  } catch (error) {
    if (!(error instanceof AmountError)) throw error;
    return { kind: "refused", reason: "invalid_amount", error: badRequest(error.message) };
  }
  if (credit === 0n) {
    return {
      kind: "refused",
      reason: "invalid_amount",
      error: badRequest("Amount must be greater than zero"),
    };
  }
  return {
    kind: "expected",
    expectation: { asset: terms.asset, decimals: terms.decimals, credit },
  };
}

/**
 * What a new request expects (ADR 0012): the credit its destination must
 * receive, in base units, at the decimals the mint's terms have now.
 *
 * @param token - The request's token: a mint address.
 * @param amount - The receipt in token units, as the request sent it.
 * @throws AppError (400) when the token is not a mint SDP can move (the
 * capability decision, with its `reason`), or the amount has more decimals
 * than the mint (SOLA9-803), is zero or is out of range.
 */
export async function resolvePaymentRequestExpectation(
  token: string,
  amount: string
): Promise<PaymentRequestExpectation> {
  const read = await readPaymentRequestExpectation(token, amount);
  if (read.kind === "refused") {
    throw read.error;
  }
  return read.expectation;
}

/** A request's expectation as the API reports it. */
export function paymentRequestAmounts(
  expectation: PaymentRequestExpectation
): TokenMovementExpectation {
  return {
    basis: "credit",
    credit: toTokenAmount(expectation.credit, expectation.decimals).value,
    decimals: expectation.decimals,
  };
}

/** What /pay moves for a request: the asset, and its credit in token units. */
export interface PaymentRequestPayment {
  asset: AssetRequest;
  /** The credit in token units. */
  amount: string;
  /** The stored expectation the plan must meet; null for a request before expectations. */
  expectation: PaymentRequestExpectation | null;
}

/**
 * What /pay moves for a request. A request recorded before expectations
 * (migration 0184, or by the previous revision during the deploy) is paid as
 * before: its amount at the decimals /pay reads.
 */
export function paymentRequestPayment(row: PaymentRequestRow): PaymentRequestPayment {
  const { expectation } = row;
  if (expectation === null) {
    return { asset: paymentRequestAsset(row.token), amount: row.amount, expectation: null };
  }
  return {
    asset: expectation.asset,
    amount: toTokenAmount(expectation.credit, expectation.decimals).value,
    expectation,
  };
}

/** Whether moving `credit` of `asset` at `decimals` delivers `expectation`. */
function deliversExpectation(
  asset: AssetRef,
  decimals: number,
  credit: BaseUnits,
  expectation: PaymentRequestExpectation
): boolean {
  return (
    isSameAsset(asset, expectation.asset) &&
    decimals === expectation.decimals &&
    credit === expectation.credit
  );
}

/**
 * Refuses a /pay plan that would not deliver the request's expectation: the
 * mint was closed and created again with other decimals or under another
 * program, so the credit no longer means what the request recorded.
 *
 * @throws AppError (400) when the plan's asset, decimals or credit differ.
 */
export function assertPlanMeetsExpectation(
  plan: PlannedTokenMovement,
  expectation: PaymentRequestExpectation | null
): void {
  if (expectation === null) {
    return;
  }
  const [leg] = plan.legs;
  if (
    leg === undefined ||
    !deliversExpectation(plan.terms.asset, plan.terms.decimals, leg.quote.credit, expectation)
  ) {
    throw badRequest(
      "This token's mint changed since the payment request was created; it can no longer be paid"
    );
  }
}

const foundPaymentSchema = z.object({
  signature: z.custom<Signature>(),
  slot: z.bigint(),
  blockTime: z.bigint().nullable(),
  /** The /pay window that issued the payment; null for any other transaction. */
  issued: z.custom<SignedPaymentRequestTransaction>().nullable(),
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
  z.object({
    kind: z.literal("expected"),
    fields: z.custom<PaymentRequestTransferFields>(),
    expectation: z.custom<PaymentRequestExpectation>(),
  }),
  z.object({ kind: z.literal("blocked"), reason: z.enum(SETTLEMENT_BLOCKED_REASONS) }),
]);
type TransferExpectation = z.infer<typeof transferExpectationSchema>;
type ExpectedTransfer = Extract<TransferExpectation, { kind: "expected" }>;

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
  const expected = await expectedTransfer(row, reference);
  if (expected.kind === "blocked") {
    return { kind: "skipped", reason: expected.reason };
  }
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
  const issued = fetched.newestFirst.length === 0 ? [] : await listOpenIssuedTransactions(env, row);
  const scan = await evaluateOldestFirst(
    row,
    expected,
    issued,
    [...fetched.newestFirst].reverse(),
    { signature: from.stuckSignature, since: from.stuckSince }
  );
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
  expected: ExpectedTransfer,
  issued: readonly SignedPaymentRequestTransaction[],
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
      verdict = await judgeCandidate(expected, issued, candidate);
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

/**
 * Judges one finalized candidate. A transaction /pay issued for the request
 * (its sponsor signature is the transaction id) moved exactly the quote SDP
 * built, so its window's quote settles it when it delivers the request's
 * expectation, with no transaction read: the validator knows neither
 * `TransferCheckedWithFee` nor hook accounts before the reference. Every
 * other transaction goes through the validator.
 */
async function judgeCandidate(
  expected: ExpectedTransfer,
  issued: readonly SignedPaymentRequestTransaction[],
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
  const window = issued.find((entry) => entry.signature === candidate.signature);
  if (window !== undefined) {
    const { quote } = window;
    return deliversExpectation(
      quote.asset,
      quote.decimals,
      quote.quoted.credit,
      expected.expectation
    )
      ? {
          kind: "paid",
          found: {
            signature: candidate.signature,
            slot: candidate.slot,
            blockTime: candidate.blockTime,
            issued: window,
          },
        }
      : { kind: "rejected" };
  }
  let validated: Awaited<ReturnType<typeof validatePaymentRequestTransfer>>;
  try {
    validated = await validatePaymentRequestTransfer(candidate.signature, expected.fields);
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
      issued: null,
    },
  };
}

/**
 * What a request's payment must deliver, as the validator checks it: the
 * stored expectation, with no read, or for a request recorded before
 * expectations, its amount at the decimals its mint has now.
 */
async function expectedTransfer(
  row: PaymentRequestRow,
  reference: Address
): Promise<TransferExpectation> {
  let expectation = row.expectation;
  if (expectation === null) {
    let read: ExpectationRead;
    try {
      read = await readPaymentRequestExpectation(row.token, row.amount, true);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "BAD_REQUEST") throw error;
      read = { kind: "refused", reason: "mint_not_admitted", error };
    }
    if (read.kind === "refused") {
      // Legacy requests may predate create-time checks. They must never
      // settle against a refused mint or a rounded or out-of-range amount.
      getLogger().warn(
        { payment_request_id: row.id, reason: read.reason, error: read.error.message },
        "Payment request settlement skipped"
      );
      return { kind: "blocked", reason: read.reason };
    }
    expectation = read.expectation;
  }
  const { asset } = expectation;
  const fields: PaymentRequestTransferFields = {
    recipient: assertValidAddress(row.destination_address, "destinationAddress"),
    amount: expectation.credit,
    decimals: expectation.decimals,
    tokenProgram: address(SPL_TOKEN_PROGRAMS[asset.kind === "token" ? asset.program : "spl-token"]),
    reference,
    ...(asset.kind === "token" ? { splToken: asset.mint } : {}),
  };
  return { kind: "expected", fields, expectation };
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
  await requestsRepository(env, key).advanceSignatureScan({ ...key, from, to });
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
        createPostgresTokenMovementLegsRepository(db, scope),
        row,
        key.projectId,
        custodyWalletId,
        found
      );
      const requestsRepo = createTransactionalPaymentRequestsRepository(db, scope);
      if (found.issued !== null) {
        await requestsRepo.closePaymentRequestTransactions({
          ...key,
          outcomes: [{ signature: found.signature, outcome: "landed", landedSlot: found.slot }],
        });
      }
      const transition = await transitionToPaid(requestsRepo, row, key, transfer.id, paidLate);
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

function requestsRepository(env: Env, key: PaymentRequestKey): PaymentRequestsRepository {
  return createPaymentRequestsRepository(
    env,
    createTenantScope({ organizationId: key.organizationId, projectId: key.projectId })
  );
}

/** The request's signed /pay windows still open, read in its own tenant. */
function listOpenIssuedTransactions(
  env: Env,
  row: PaymentRequestRow
): Promise<SignedPaymentRequestTransaction[]> {
  const key = paymentRequestKey(row);
  return requestsRepository(env, key).listOpenPaymentRequestTransactions(key);
}

/**
 * Closes the request's signed /pay windows that can no longer land and
 * returns the ones that still can: /pay issues no new window while one is
 * open, or the payer could pay twice. A window closes when its signature
 * failed at confirmed or above (below, the result can still change with its
 * fork), or has no record once the chain is past its blockhash's last valid
 * block height, on a node that has processed the slot the tip was read at.
 * One that landed stays open until settlement closes it.
 *
 * RPC budget: none without an open window; otherwise one
 * `getSignatureStatuses` per 256 windows, after one `getEpochInfo` when a
 * window is old enough to have lapsed.
 */
export async function closeIssuedWindowsThatCannotLand(
  env: Env,
  rpc: SolanaRpc,
  row: PaymentRequestRow
): Promise<SignedPaymentRequestTransaction[]> {
  const open = await listOpenIssuedTransactions(env, row);
  if (open.length === 0) {
    return [];
  }
  const lapseCutoff = Date.now() - BLOCKHASH_LIFETIME_MS;
  const chainTip = open.some((entry) => Date.parse(entry.createdAt) <= lapseCutoff)
    ? await withTransientRpcRetry(() => rpc.getEpochInfo({ commitment: "confirmed" }).send())
    : null;
  const closed: {
    signature: Signature;
    outcome: Exclude<FinalPaymentRequestTransactionOutcome, "landed">;
    landedSlot: bigint | null;
  }[] = [];
  for (let start = 0; start < open.length; start += MAX_SIGNATURES_PER_STATUS_READ) {
    const page = open.slice(start, start + MAX_SIGNATURES_PER_STATUS_READ);
    const statuses = await withTransientRpcRetry(() =>
      rpc
        .getSignatureStatuses(
          page.map((entry) => entry.signature),
          { searchTransactionHistory: true }
        )
        .send()
    );
    page.forEach((entry, index) => {
      const status = statuses.value[index];
      if (status) {
        const confirmed =
          status.confirmationStatus !== null &&
          commitmentComparator(status.confirmationStatus, "confirmed") >= 0;
        if (confirmed && status.err !== null) {
          closed.push({ signature: entry.signature, outcome: "failed", landedSlot: status.slot });
        }
        return;
      }
      if (
        chainTip !== null &&
        chainTip.blockHeight > entry.lastValidBlockHeight &&
        statuses.context.slot >= chainTip.absoluteSlot
      ) {
        closed.push({ signature: entry.signature, outcome: "lapsed", landedSlot: null });
      }
    });
  }
  const key = paymentRequestKey(row);
  await requestsRepository(env, key).closePaymentRequestTransactions({ ...key, outcomes: closed });
  const closedSignatures = new Set(closed.map((entry) => entry.signature));
  return open.filter((entry) => !closedSignatures.has(entry.signature));
}

/**
 * Records the inbound transfer that paid a request. One /pay issued gets its
 * leg: the window's quote, verified by construction, since SDP built and
 * signed it and it landed. A row another writer recorded for the signature is
 * linked instead, with no leg added.
 */
async function recordInboundTransfer(
  paymentsRepo: PaymentsRepository,
  legs: TokenMovementLegsRepository,
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
  if (found.issued !== null) {
    await legs.insertSettledTransferLeg({
      transferId: transfer.id,
      quote: found.issued.quote,
      verdict: BUILT_MOVEMENT_VERDICTS.finalized,
    });
  }
  return transfer;
}
