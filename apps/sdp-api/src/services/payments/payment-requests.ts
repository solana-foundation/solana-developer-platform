/**
 * Payment requests (ADR 0012): what a request expects, and its settlement on
 * the signatures SDP issued for it.
 *
 * A request stores an expectation: the credit its destination must receive,
 * in base units, resolved and read at creation. /pay quotes the payer's debit
 * for that credit under the terms it reads, builds the transfer with
 * `buildTokenMovement` and sponsors it (`payment-request-sponsorship.ts`).
 *
 * Settlement reads only the transactions /pay issued. The sponsor is the fee
 * payer and signs first, so each issued transaction's id is its sponsor
 * signature, saved with the claim window that issued it. A landed one moved
 * exactly what SDP built: its leg is verified by construction, with no
 * `getTransaction`. A transfer someone else sends with the request's
 * reference settles nothing (SOLA9-699).
 *
 * Which signatures: every issued transaction of the request whose signature
 * is saved and whose window is still `open`. A window closes when its
 * signature lands (`landed`), lands with an error (`failed`), or has no
 * record while the chain is past its blockhash's last valid block height
 * (`lapsed`, the rule `readSavedSend` uses): it can never land then. An open
 * window is checked even after the request expires, since it was issued
 * while the request was open and may have landed before the expiry.
 *
 * RPC budget per reconcile (before → now):
 * - no open window: one `getSignaturesForAddress` → none.
 * - open windows: one `getSignaturesForAddress`, then for a found payment
 *   `getSignatureStatuses` and two `getTransaction` → one
 *   `getSignatureStatuses` for all of them, plus one `getEpochInfo` first
 *   when a window is old enough to have lapsed.
 */

import { SdpRpcError } from "@sdp/rpc/errors";
import { createClusterRpc } from "@sdp/rpc/factory";
import type { SolanaRpc } from "@sdp/rpc/solana";
import { withTransientRpcRetry } from "@sdp/rpc/transient";
import { AmountError } from "@sdp/solana/amount";
import { type AssetRequest, isSameAsset, NATIVE_ASSET } from "@sdp/solana/asset-ref";
import {
  type BaseUnits,
  parseTokenAmount,
  toBaseUnits,
  toTokenAmount,
} from "@sdp/solana/token-amount";
import { support } from "@sdp/solana/token-movement";
import type { FinalPaymentRequestTransactionOutcome } from "@sdp/types/payments";
import { BUILT_MOVEMENT_VERDICTS, type TokenMovementExpectation } from "@sdp/types/token-movements";
import { commitmentComparator, type Signature } from "@solana/kit";
import { asTransactionalClient, type DatabaseExecutor, getDb } from "@/db/client";
import type {
  PaymentRequestExpectation,
  PaymentRequestRow,
  SignedPaymentRequestTransaction,
} from "@/db/repositories/payment-requests.repository";
import { createPostgresPaymentRequestsRepository } from "@/db/repositories/payment-requests.repository.postgres";
import {
  generatePaymentTransferId,
  type PaymentTransferRow,
} from "@/db/repositories/payments.repository";
import { createPostgresPaymentsRepository } from "@/db/repositories/payments.repository.postgres";
import { createPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import { createPostgresTokenMovementLegsRepository } from "@/db/repositories/token-movement-legs.repository";
import { AppError, badRequest, internalError } from "@/lib/errors";
import { createTenantScope } from "@/lib/tenant-scope";
import { getLogger } from "@/runtime/logger";
import { logEvent } from "@/runtime/money-path-events";
import { isNativePaymentToken, resolvePaymentAsset } from "@/services/payment-operation.service";
import type { PlannedTokenMovement } from "@/services/token-movement/build";
import { readTokenTerms } from "@/services/token-movement/read-terms";
import type { Env } from "@/types/env";

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

/**
 * What a new request expects: its asset, resolved, and its amount as a credit
 * in base units at the decimals the mint's terms have now.
 *
 * RPC budget: one terms read (`getMultipleAccounts` of the mint and the
 * Clock); native SOL none. Creating a request read nothing before.
 *
 * @param token - The request's token: a mint address.
 * @param amount - The receipt in token units, as the request sent it.
 * @throws AppError (400) when the token is not a mint SDP can move (the
 * capability decision, with its `reason`), or the amount has more decimals
 * than the mint (SOLA9-803) or is out of range.
 */
export async function resolvePaymentRequestExpectation(
  token: string,
  amount: string
): Promise<PaymentRequestExpectation> {
  const terms = await readTokenTerms(paymentRequestAsset(token));
  const decision = support(terms, "builder");
  if (!decision.supported) {
    throw badRequest(decision.message, { reason: decision.refusal });
  }
  let credit: BaseUnits;
  try {
    credit = toBaseUnits(parseTokenAmount(amount, terms.decimals));
  } catch (error) {
    if (error instanceof AmountError) {
      throw badRequest(error.message);
    }
    throw error;
  }
  if (credit === 0n) {
    throw badRequest("Amount must be greater than zero");
  }
  return { asset: terms.asset, decimals: terms.decimals, credit };
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
 * (migration 0162, or by the previous revision during the deploy) is paid as
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
    !isSameAsset(plan.terms.asset, expectation.asset) ||
    plan.terms.decimals !== expectation.decimals ||
    leg === undefined ||
    leg.quote.credit !== expectation.credit
  ) {
    throw badRequest(
      "This token's mint changed since the payment request was created; it can no longer be paid"
    );
  }
}

/**
 * Checks the transactions SDP issued for the request and, when one landed,
 * records the inbound transfer with its leg and marks the request paid.
 *
 * Reads the chain on the open cluster scope's cluster (the row's Project).
 *
 * @param env - API environment for database access.
 * @param row - The stored payment request row to reconcile.
 * @param options.bestEffort - When true, unexpected infra failures (e.g. an
 *   RPC outage) degrade to the stored row with a log so one bad row cannot
 *   take down a whole list read or the public pay page; the next read
 *   retries. An unresolved legacy wallet also returns the stored row because
 *   the exact-identity backfill intentionally leaves ambiguous rows unpinned.
 *   Other invariant violations (AppError) always rethrow — they do
 *   not self-heal and must not hide behind a stale row. When false, every
 *   failure rethrows, for paths that must not act on stale state.
 * @returns The settled row when an issued transaction landed, otherwise the
 *   stored row.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope, or
 *   `RPC_NOT_CONFIGURED` when the cluster has no endpoint, even when best-effort.
 */
export async function reconcilePaymentRequest(
  env: Env,
  row: PaymentRequestRow,
  options: { bestEffort: boolean }
): Promise<PaymentRequestRow> {
  if (row.status !== "awaiting_payment") {
    return row;
  }
  if (row.custody_wallet_id === null) {
    if (options.bestEffort) {
      return row;
    }
    throw new AppError("CONFLICT", "Payment request wallet identity is unresolved");
  }

  const degrade = (cause: unknown): PaymentRequestRow => {
    // Best effort degrades on RPC transport failures only; configuration and scope errors stay loud.
    if (
      !options.bestEffort ||
      cause instanceof AppError ||
      (cause instanceof SdpRpcError && cause.code !== "SOLANA_RPC_ERROR")
    ) {
      throw cause;
    }
    getLogger().error(
      {
        payment_request_id: row.id,
        error: cause instanceof Error ? cause.message : String(cause),
      },
      "reconcilePaymentRequest: best-effort reconcile failed, returning stored row"
    );
    return row;
  };
  let open: SignedPaymentRequestTransaction[];
  try {
    open = await listOpenTransactions(env, row);
  } catch (err) {
    return degrade(err);
  }
  if (open.length === 0) {
    // No window left to read: either none was issued, or a concurrent
    // reconcile settled the request and closed them. Answer the current row.
    return currentPaymentRequest(env, row);
  }
  // Outside the best-effort net: a cluster with no endpoint is a configuration error.
  const rpc = createClusterRpc();
  try {
    return await settlePaymentRequestIfPaid(env, rpc, row, {
      custodyWalletId: row.custody_wallet_id,
      open,
    });
  } catch (err) {
    return degrade(err);
  }
}

/** The organization and project a request belongs to. */
interface RequestOwner {
  organizationId: string;
  projectId: string;
}

/**
 * The request's Project. A request without one cannot have issued anything.
 * TODO: once migration 0129 makes payment_requests.project_id NOT NULL
 * (HOO-1966), narrow PaymentRequestRow.project_id to string and delete this.
 */
function requestOwner(row: PaymentRequestRow): RequestOwner {
  if (row.project_id === null) {
    throw internalError("payment_requests row is missing project_id");
  }
  return { organizationId: row.organization_id, projectId: row.project_id };
}

/** The request as stored now, read in its own tenant. */
async function currentPaymentRequest(env: Env, row: PaymentRequestRow): Promise<PaymentRequestRow> {
  const owner = requestOwner(row);
  const current = await createPaymentRequestsRepository(
    env,
    createTenantScope(owner)
  ).getPaymentRequestById({ requestId: row.id, ...owner });
  if (current === null) {
    throw internalError(`Payment request ${row.id} disappeared while it was reconciled`);
  }
  return current;
}

/** The request's signed issued transactions still open, read in its own tenant. */
function listOpenTransactions(
  env: Env,
  row: PaymentRequestRow
): Promise<SignedPaymentRequestTransaction[]> {
  const owner = requestOwner(row);
  return createPaymentRequestsRepository(
    env,
    createTenantScope(owner)
  ).listOpenPaymentRequestTransactions({ requestId: row.id, ...owner });
}

/** An issued transaction whose signature landed successfully, at `slot`. */
interface LandedTransaction {
  issued: SignedPaymentRequestTransaction;
  slot: bigint;
}

/** What one read of the issued transactions' signatures showed. */
interface IssuedTransactionsRead {
  landed: LandedTransaction[];
  closed: {
    signature: Signature;
    outcome: Exclude<FinalPaymentRequestTransactionOutcome, "landed">;
    landedSlot: bigint | null;
  }[];
}

/**
 * Reads the status of each open issued transaction. The chain tip is read
 * first, and only when a window is old enough to have lapsed: once the chain
 * is past a blockhash's expiry, nothing signed with it lands after the status
 * read. A pool may answer from different nodes, so a window lapses only on a
 * node that has processed the slot the tip was read at.
 */
async function readIssuedTransactions(
  rpc: SolanaRpc,
  issued: readonly SignedPaymentRequestTransaction[]
): Promise<IssuedTransactionsRead> {
  const lapseCutoff = Date.now() - BLOCKHASH_LIFETIME_MS;
  const chainTip = issued.some((entry) => Date.parse(entry.createdAt) <= lapseCutoff)
    ? await withTransientRpcRetry(() => rpc.getEpochInfo({ commitment: "confirmed" }).send())
    : null;
  const read: IssuedTransactionsRead = { landed: [], closed: [] };
  for (let start = 0; start < issued.length; start += MAX_SIGNATURES_PER_STATUS_READ) {
    const page = issued.slice(start, start + MAX_SIGNATURES_PER_STATUS_READ);
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
        // Below confirmed, the result can still change with its fork: a
        // processed failure may land later, so it leaves the window open.
        const confirmed =
          status.confirmationStatus !== null &&
          commitmentComparator(status.confirmationStatus, "confirmed") >= 0;
        if (!confirmed) {
          return;
        }
        if (status.err === null) {
          read.landed.push({ issued: entry, slot: status.slot });
        } else {
          read.closed.push({
            signature: entry.signature,
            outcome: "failed",
            landedSlot: status.slot,
          });
        }
        return;
      }
      if (
        chainTip !== null &&
        chainTip.blockHeight > entry.lastValidBlockHeight &&
        statuses.context.slot >= chainTip.absoluteSlot
      ) {
        read.closed.push({ signature: entry.signature, outcome: "lapsed", landedSlot: null });
      }
    });
  }
  read.landed.sort((left, right) => (left.slot < right.slot ? -1 : left.slot > right.slot ? 1 : 0));
  return read;
}

/**
 * @returns The settled row, or the row unchanged when no issued transaction
 *   has landed yet.
 */
async function settlePaymentRequestIfPaid(
  env: Env,
  rpc: SolanaRpc,
  row: PaymentRequestRow,
  input: { custodyWalletId: string; open: readonly SignedPaymentRequestTransaction[] }
): Promise<PaymentRequestRow> {
  const owner = requestOwner(row);
  const { custodyWalletId } = input;
  const read = await readIssuedTransactions(rpc, input.open);
  const [paying, ...alsoLanded] = read.landed;
  if (paying === undefined) {
    await createPaymentRequestsRepository(
      env,
      createTenantScope(owner)
    ).closePaymentRequestTransactions({ requestId: row.id, ...owner, outcomes: read.closed });
    return row;
  }
  if (alsoLanded.length > 0) {
    logEvent("error", {
      event: "sdp_api_payment_request_paid_twice",
      organization_id: owner.organizationId,
      project_id: owner.projectId,
      payment_request_id: row.id,
      signatures: read.landed.map((landed) => landed.issued.signature),
    });
  }
  return getDb(env).transaction((tx) =>
    settleWithIssuedTransaction(tx, owner, {
      requestId: row.id,
      custodyWalletId,
      landed: read.landed,
      closed: read.closed,
      paying,
    })
  );
}

/**
 * In one transaction, under the request row's lock: records the inbound
 * transfer and its verified leg, marks the request paid, and closes every
 * window the read settled, the landed ones and any that failed or lapsed, in
 * one statement. A concurrent reconcile waits on the lock and finds the
 * request paid.
 */
async function settleWithIssuedTransaction(
  tx: DatabaseExecutor,
  owner: RequestOwner,
  input: {
    requestId: string;
    custodyWalletId: string;
    landed: readonly LandedTransaction[];
    closed: IssuedTransactionsRead["closed"];
    paying: LandedTransaction;
  }
): Promise<PaymentRequestRow> {
  const txClient = asTransactionalClient(tx);
  const requests = createPostgresPaymentRequestsRepository(txClient);
  const current = await requests.lockPaymentRequest({ requestId: input.requestId, ...owner });
  if (current === null) {
    throw internalError("payment request not found during settlement");
  }
  await requests.closePaymentRequestTransactions({
    requestId: input.requestId,
    ...owner,
    outcomes: [
      ...input.closed,
      ...input.landed.map((landed) => ({
        signature: landed.issued.signature,
        outcome: "landed" as const,
        landedSlot: landed.slot,
      })),
    ],
  });
  if (current.status !== "awaiting_payment") {
    return current;
  }
  const transfer = await recordInboundTransfer(tx, owner, current, input);
  const paid = await requests.markPaymentRequestPaid({
    requestId: current.id,
    organizationId: owner.organizationId,
    projectId: owner.projectId,
    fulfilledByTransferId: transfer.id,
    issuedAt: input.paying.issued.createdAt,
  });
  if (paid === null) {
    // The claim refuses an expired request, so its transaction was issued
    // before the expiry; a miss here means the row broke that invariant.
    throw internalError("Payment request settlement compare-and-set matched no row");
  }
  return paid;
}

/**
 * Records the inbound transfer that paid a request, with its leg: the issued
 * transaction's quote, verified by construction because SDP built and signed
 * it and its signature landed. Its `amount` is the credit. A row another
 * writer recorded for the same signature (an observed inbound transfer) is
 * linked instead when it matches the request, with no leg added.
 */
async function recordInboundTransfer(
  tx: DatabaseExecutor,
  owner: RequestOwner,
  row: PaymentRequestRow,
  input: { custodyWalletId: string; paying: LandedTransaction }
): Promise<PaymentTransferRow> {
  const { issued, slot } = input.paying;
  const { quote } = issued;
  const credit = toTokenAmount(quote.quoted.credit, quote.decimals).value;
  const tenant = createTenantScope(owner);
  const txClient = asTransactionalClient(tx);
  const payments = createPostgresPaymentsRepository(txClient, tenant);
  const [existing] = await payments.listTransfersBySignatures({
    signatures: [issued.signature],
    organizationId: owner.organizationId,
    projectId: owner.projectId,
  });
  if (existing !== undefined) {
    if (
      existing.custody_wallet_id !== row.custody_wallet_id ||
      existing.wallet_id !== row.wallet_id ||
      existing.destination_address !== row.destination_address ||
      existing.token !== row.token ||
      existing.amount === null ||
      !recordsCredit(existing.amount, quote.quoted.credit, quote.decimals) ||
      existing.type !== "transfer" ||
      existing.direction !== "inbound"
    ) {
      throw new AppError("CONFLICT", "Recorded transfer does not match payment request");
    }
    return existing;
  }

  const transfer = await payments.createTransfer({
    id: generatePaymentTransferId(),
    organizationId: owner.organizationId,
    projectId: owner.projectId,
    custodyWalletId: input.custodyWalletId,
    walletId: row.wallet_id,
    counterpartyId: null,
    sourceAddress: issued.payer,
    destinationAddress: row.destination_address,
    token: row.token,
    amount: credit,
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
    signature: issued.signature,
    slot: Number(slot),
    initiatedByKeyId: null,
  });
  if (transfer === null) {
    throw internalError("Failed to record inbound transfer for payment request settlement");
  }
  await createPostgresTokenMovementLegsRepository(tx, tenant).insertSettledTransferLeg({
    transferId: transfer.id,
    quote,
    verdict: BUILT_MOVEMENT_VERDICTS.confirmed,
  });
  return transfer;
}

/** Whether a recorded amount text is `credit` at `decimals`. */
function recordsCredit(amount: string, credit: BaseUnits, decimals: number): boolean {
  try {
    return toBaseUnits(parseTokenAmount(amount, decimals)) === credit;
  } catch (error) {
    if (error instanceof AmountError) {
      return false;
    }
    throw error;
  }
}
