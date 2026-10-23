import { compareDecimalAmounts } from "@sdp/payments/decimal";
// biome-ignore lint/style/noRestrictedImports: the transfers list reads wallet signature history through the Helius-first pool
import { createClusterHistoryRpc, createClusterRpc } from "@sdp/rpc/factory";
import { confirmTransaction, getRecentBlockhash, getSignaturesForAddress } from "@sdp/rpc/solana";
import { formatDecimalAmount } from "@sdp/solana/amount";
import type { MovementQuote } from "@sdp/solana/movement-quote";
import { toTokenAmount } from "@sdp/solana/token-amount";
import type { Action } from "@sdp/types/actions";
import {
  isRampTransferType,
  isSuccessfulPaymentTransferStatus,
  OFFRAMP_DEPOSIT_OUTCOME_TRANSITIONS,
  PAYMENT_TRANSFER_TYPES,
  RAMP_TRANSFER_TYPES,
  TRANSFER_CHAIN_VERDICT_STATUSES,
  type TransferLandingStatus,
  type PaymentTransferStatus as TransferStatus,
  type PaymentTransferType as TransferType,
  transferLandingStatus,
  WALLET_TRANSFER_TYPES,
} from "@sdp/types/payments";
import type { TokenMovementBasis } from "@sdp/types/token-movements";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import {
  type Address,
  address,
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getTransactionEncoder,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type TransactionSigner,
} from "@solana/kit";
import { partiallySignTransactionMessageWithSigners } from "@solana/signers";
import { z } from "zod";
import { getDb } from "@/db/client";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import {
  generatePaymentTransferId,
  type PaymentTransferDirection as TransferDirection,
  type PaymentTransferRow as TransferRow,
} from "@/db/repositories/payments.repository";
import { getAuth, requireProjectId } from "@/lib/auth";
import { mapSettledWithConcurrency } from "@/lib/concurrency";
import {
  AppError,
  accountFrozen,
  badRequest,
  badRequestQuery,
  conflict,
  type ErrorCode,
  internalError,
  isErrorCode,
  missingAction,
  notFound,
  solanaRpcError,
  transactionFailed,
} from "@/lib/errors";
import { assertCallerMaySignWith } from "@/lib/money-admission";
import { appErrorResponse, paginated, success } from "@/lib/response";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import { type AuthorizeInput, getAuthorized } from "@/middleware/authorize";
import {
  getIdempotencyFingerprint,
  getIdempotencyRecordKey,
  markIdempotencyCommitted,
  markIdempotencyRecordMismatch,
  markIdempotencyReleased,
} from "@/middleware/idempotency";
import { enforceMeteredQuota } from "@/middleware/metered-quota";
import type { MovementStepInput, RecordAnswer } from "@/middleware/movement-steps";
import { callerMayPerform } from "@/middleware/require-action";
import {
  assertModuleInChannel,
  assertTransferRampProviderInChannel,
  isModuleInChannel,
} from "@/middleware/require-module";
import type { ValidatedBodyContext } from "@/middleware/validate";
import {
  type AppContext,
  getPaymentsRepository,
  getTokenMovementLegsRepository,
} from "@/routes/payments/context";
import { mapTransferWithLegs } from "@/routes/payments/mappers";
import { transferIdParamsSchema } from "@/routes/payments/schemas";
import { resolveTokenLabel } from "@/routes/payments/token-accounts";
import {
  admitPaymentWalletRuntimeExecution,
  type ResolvedScope,
  resolveScope,
  resolveWalletByCustodyWalletId,
} from "@/routes/payments/wallets";
import { getLogger } from "@/runtime/logger";
import { describeError, logEvent } from "@/runtime/money-path-events";
import { AuditService } from "@/services/audit.service";
import {
  assertPaymentProjectScope,
  normalizePaymentToken,
  type OutboundPaymentOperation,
  resolveOutboundPaymentOperation,
} from "@/services/payment-operation.service";
import {
  isFireblocksTransfer,
  prepareFireblocksTransfer,
  refreshFireblocksTransfer,
  submitFireblocksTransfer,
} from "@/services/payments/fireblocks-transfer";
import { signWithFreshBlockhash } from "@/services/payments/sign-with-fresh-blockhash";
import { createTransferSignedSubmissionStore } from "@/services/payments/signed-submission";
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
import {
  createSponsorshipFeePayment,
  resolveRequestSponsorshipScope,
} from "@/services/sponsorship.service";
import {
  isDefiniteSubmissionError,
  type SignedSubmissionStore,
  submitSponsoredTransaction,
} from "@/services/sponsorship-submission";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import {
  buildPlannedLeg,
  type PlannedLeg,
  type PlannedTokenMovement,
  planTokenMovement,
} from "@/services/token-movement/build";
import { claimOfframpDepositWithLeg, recordQuotedTransfer } from "@/services/token-movement/record";
import {
  buildObservedTransfersForSignatures,
  dedupeSignatureHistory,
  MAX_TOKEN_ACCOUNT_SIGNATURE_LOOKUPS,
  resolveWalletTokenAccountAddresses,
  SIGNATURE_HISTORY_LOOKUP_CONCURRENCY,
} from "./observed-transfers";
import {
  type createTransferSchema,
  listTransfersQuerySchema,
  requestedTransferBasis,
} from "./schemas";

async function createTransferRecord(
  c: AppContext,
  input: {
    organizationId: string;
    projectId: string;
    custodyWalletId: string;
    walletId: string;
    sourceAddress: string;
    destinationAddress: string;
    token: string;
    /** The quoted movement: the row's amount is its debit, and its leg is the quote. */
    quote: MovementQuote;
    memo?: string;
    status: TransferStatus;
    initiatedByKeyId: string;
    /**
     * The request's credential-bound record key and the key layer's
     * fingerprint, recorded on the row; `replayFromRecord` answers a retry
     * from them before this runs.
     */
    idempotency: { key: string; fingerprint: string } | null;
    providerData?: Record<string, unknown>;
  }
): Promise<{ row: TransferRow; replayed: boolean }> {
  const idempotencyKey = input.idempotency?.key ?? null;
  try {
    const createdRow = await recordQuotedTransfer(
      getDb(c.env),
      getRequestTenantScope(c),
      {
        id: generatePaymentTransferId(),
        organizationId: input.organizationId,
        projectId: input.projectId,
        custodyWalletId: input.custodyWalletId,
        walletId: input.walletId,
        counterpartyId: null,
        sourceAddress: input.sourceAddress,
        destinationAddress: input.destinationAddress,
        token: input.token,
        memo: input.memo ?? null,
        type: "transfer",
        direction: "outbound",
        status: input.status,
        provider: null,
        providerReference: null,
        deliveryMode: null,
        fiatCurrency: null,
        fiatAmount: null,
        providerData: input.providerData ?? {},
        serializedTx: null,
        signature: null,
        slot: null,
        initiatedByKeyId: input.initiatedByKeyId,
        idempotencyKey,
        idempotencyFingerprint: input.idempotency?.fingerprint ?? null,
      },
      input.quote
    );

    return { row: createdRow, replayed: false };
  } catch (error) {
    if (idempotencyKey && isPostgresUniqueViolation(error)) {
      // A concurrent attempt under this key (a takeover) wrote the row first.
      const existing = await getPaymentsRepository(c).findTransferByIdempotency({
        organizationId: input.organizationId,
        projectId: input.projectId,
        idempotencyKey,
      });
      if (existing) {
        if (existing.idempotency_fingerprint !== input.idempotency?.fingerprint) {
          // Another request's row: refused unstored, so that request's own retry
          // is still answered from it.
          markIdempotencyRecordMismatch(c);
          throw new AppError("IDEMPOTENCY_KEY_REUSED");
        }
        return { row: existing, replayed: true };
      }
    }
    throw error;
  }
}

type CreateTransferBody = z.output<typeof createTransferSchema>;

interface TransferResolved {
  scope: ResolvedScope;
  operation: OutboundPaymentOperation;
  /** Which side of the transfer the request's amount fixes, its default applied. */
  basis: TokenMovementBasis;
  /** The ramp deposit a `transferId` request funds, in the caller's project, whatever its state. */
  rampTransfer: TransferRow | null;
}

/** The one leg of a movement to one destination. */
function singleLeg(plan: PlannedTokenMovement): PlannedLeg {
  const [leg, ...rest] = plan.legs;
  if (leg === undefined || rest.length > 0) {
    throw internalError("A transfer plans exactly one leg");
  }
  return leg;
}

function rampTransferHasOnchainValues(transfer: TransferRow): boolean {
  return (
    transfer.destination_address !== null ||
    transfer.signature !== null ||
    transfer.serialized_tx !== null ||
    transfer.signed_transaction !== null ||
    transfer.last_valid_block_height !== null ||
    transfer.submission_started_at !== null ||
    transfer.slot !== null ||
    transfer.block_time !== null ||
    transfer.fee !== null
  );
}

const rampCryptoDepositSchema = z.object({
  destinationAddress: z.string(),
  amount: z.string(),
});

function getRampCryptoDeposit(transfer: TransferRow) {
  const result = rampCryptoDepositSchema.safeParse(transfer.provider_data.cryptoDeposit);
  return result.success ? result.data : null;
}

/**
 * Refuses a token deposit the source wallet cannot send now: its quoted debit,
 * the provider's deposit grossed up by the mint's fee. It runs before the
 * claim: a send that fails after it fails the sale for good, while this
 * refusal leaves it awaiting payment for a retry. A native SOL deposit is not
 * checked here; the chain refuses one the wallet cannot pay.
 */
function assertRampDepositFunded(transfer: TransferRow, plan: PlannedTokenMovement): void {
  const { source, terms } = plan;
  if (source === null) return;
  const needed = singleLeg(plan).quote.debit;
  if (!source.frozen && source.amount >= needed) return;

  const mint = transfer.token;
  const token = resolveTokenLabel(mint);
  const held = formatDecimalAmount(source.amount, terms.decimals);
  const neededAmount = toTokenAmount(needed, terms.decimals).value;
  logEvent("info", {
    event: "sdp_api_ramp_deposit_refused",
    reason: source.frozen ? "account_frozen" : "insufficient_balance",
    provider: transfer.provider,
    organization_id: transfer.organization_id,
    project_id: transfer.project_id,
    transfer_id: transfer.id,
    token_mint: mint,
    held,
    needed: neededAmount,
  });
  if (source.frozen) {
    throw accountFrozen(`Source wallet's ${token} account is frozen`);
  }
  throw new AppError(
    "INSUFFICIENT_TOKEN_BALANCE",
    `Source wallet holds ${held} ${token}; this deposit needs ${neededAmount} ${token}`,
    { held, needed: neededAmount }
  );
}

/**
 * Claims the off-ramp deposit a request funds and records its leg. The
 * provider's deposit amount is a receipt: the request names it, the quote is
 * its credit, and the wallet is debited the credit grossed up by the mint's
 * fee. A SOL sale takes native SOL, never wrapped SOL.
 *
 * RPC budget: the plan's two reads (mint with the destination, and source),
 * as the mint owner and source reads before.
 */
async function updateOnchainTransferForRamp(
  c: AppContext,
  input: {
    /** The deposit row authorize loaded in the caller's project. */
    existing: TransferRow;
    scope: ResolvedScope;
    operation: OutboundPaymentOperation;
    basis: TokenMovementBasis;
    destinationAddress: string;
    /** The request's memo: a provider destination that requires memos refuses a deposit without one. */
    memo: string | null;
    idempotency: { key: string; fingerprint: string } | null;
  }
): Promise<{ row: TransferRow; plan: PlannedTokenMovement }> {
  const { existing, scope, operation, destinationAddress } = input;
  const tenant = {
    transferId: existing.id,
    organizationId: scope.auth.organizationId,
    projectId: requireProjectId(c),
  };
  // A provider the release channel leaves out is off completely: never fund its deposits.
  assertTransferRampProviderInChannel(c, existing);

  const deposit = getRampCryptoDeposit(existing);
  if (
    existing.type !== "offramp" ||
    existing.direction !== "outbound" ||
    existing.custody_wallet_id !== operation.sourceWallet.id ||
    existing.wallet_id !== operation.sourceWallet.walletId ||
    existing.source_address !== operation.sourceWallet.publicKey ||
    existing.token !== operation.token ||
    (existing.token === SOL_MINT) !== (operation.asset.kind === "native") ||
    existing.amount === null ||
    compareDecimalAmounts(existing.amount, operation.amount) !== 0 ||
    !deposit ||
    deposit.destinationAddress !== destinationAddress ||
    compareDecimalAmounts(deposit.amount, operation.amount) !== 0
  ) {
    throw badRequest("Transfer does not match the off-ramp deposit instruction");
  }
  if (rampTransferHasOnchainValues(existing)) {
    throw conflict("Ramp transfer already has an on-chain transaction");
  }
  // A provider that failed or expired the sale no longer takes this deposit.
  if (existing.status !== "awaiting_payment") {
    throw conflict(`Ramp transfer is no longer awaiting payment (status: ${existing.status})`);
  }
  const plan = await planTokenMovement({
    asset: operation.asset,
    basis: input.basis,
    source: operation.sourceAddress,
    destinations: [{ owner: operation.destinationAddress, amount: operation.amount }],
    memo: input.memo,
  });
  assertRampDepositFunded(existing, plan);

  const updated = await claimOfframpDepositWithLeg(
    getDb(c.env),
    getRequestTenantScope(c),
    {
      ...tenant,
      custodyWalletId: operation.sourceWallet.id,
      walletId: operation.sourceWallet.walletId,
      sourceAddress: operation.sourceWallet.publicKey,
      destinationAddress,
      token: operation.token,
      initiatedByKeyId: scope.auth.id,
      idempotency: input.idempotency,
      updatedAt: new Date().toISOString(),
    },
    singleLeg(plan).quote
  );
  if (!updated) {
    throw conflict("Ramp transfer already has an on-chain transaction");
  }
  return { row: updated, plan };
}

/**
 * The create-transfer access check (HOO-1918, ADR 0009): the caller may move
 * money from the named source wallet, read fresh, in its own project. It runs
 * before the Idempotency-Key is claimed, so a replay passes exactly these
 * checks. A wallet deactivated since a request ran still passes here (a replay
 * moves nothing); admission refuses new work on it.
 *
 * @returns The resolved scope and outbound operation, for the later steps.
 */
export async function authorizeTransfer(
  c: AppContext,
  input: AuthorizeInput
): Promise<TransferResolved> {
  // SAFETY: mounted after validateBody(createTransferSchema).
  const body = input.body as CreateTransferBody;
  const basis = requestedTransferBasis(body);
  if (body.transferId !== undefined && basis !== "credit") {
    throw badRequest(
      "amountBasis must be credit when funding an off-ramp deposit: amount is the provider's deposit amount, which must arrive in full"
    );
  }
  const scope = await resolveScope(c, body.sourceCustodyWalletId);
  assertPaymentProjectScope(body.projectId, requireProjectId(c));
  const operation = resolveOutboundPaymentOperation({
    wallets: scope.wallets,
    sourceCustodyWalletId: body.sourceCustodyWalletId,
    destination: body.destination,
    token: body.token,
    amount: body.amount,
  });
  // The custody signer refuses a wallet outside the key's scope (HOO-2099)
  // or of a purpose that may not send (APE-371). Refusing here as well,
  // before the key is claimed, keeps a refused start from writing a failed
  // transfer row and an Idempotency-Key that would replay that failure.
  assertCallerMaySignWith(scope.auth, operation.sourceWallet, "payments.transfer");
  // A ramp deposit the request funds is named by id: it must be in the
  // project before the key is claimed, so a wrong id is never stored as a 404.
  let rampTransfer: TransferRow | null = null;
  if (body.transferId) {
    rampTransfer = await getPaymentsRepository(c).getTransferById({
      transferId: body.transferId,
      organizationId: scope.auth.organizationId,
      projectId: requireProjectId(c),
    });
    if (!rampTransfer) throw notFound("Ramp transfer");
  }
  return { scope, operation, basis, rampTransfer };
}

/**
 * Admits a new transfer: the ramp provider is still in the release channel,
 * and the custody runtime takes the wallet (active, provider usable). State,
 * so it runs after the replay exits.
 */
export async function admitTransferExecution(
  c: AppContext,
  input: MovementStepInput<TransferResolved>
): Promise<void> {
  const { rampTransfer } = input.authorized;
  if (rampTransfer) {
    // An excluded provider's deposit is never funded.
    assertTransferRampProviderInChannel(c, rampTransfer);
  }
  await admitPaymentWalletRuntimeExecution(c, input.authorized.operation.sourceWallet);
}

/**
 * Answers a create-transfer request from its row (HOO-1918): after a takeover
 * of a crashed attempt, or once the shared record has expired. It reads the
 * validated request and what authorize resolved only, never RPC, so a request
 * that already ran is always answered.
 *
 * - A keyed transfer: the row recorded under this key with the same fingerprint.
 * - Funding a ramp deposit (`transferId`): the deposit row once funded, so a
 *   retry after a crash is answered with it instead of a 409 "already has an
 *   on-chain transaction". The key that funded it is compared by the
 *   fingerprint it recorded (other terms, a changed memo, are a 422); another
 *   key is answered when it names the same deposit.
 */
export async function findTransferRecordReplay(
  c: AppContext,
  input: MovementStepInput<TransferResolved>,
  recordKey: string
): Promise<RecordAnswer | null> {
  // SAFETY: mounted after validateBody(createTransferSchema).
  const body = input.body as CreateTransferBody;
  const { scope, operation, rampTransfer: existing } = input.authorized;
  if (body.transferId) {
    if (!existing || !rampTransferHasOnchainValues(existing)) return null;
    if (existing.idempotency_key === recordKey && existing.idempotency_fingerprint !== null) {
      // This key funded the deposit: the step compares the fingerprint it
      // recorded, as for any keyed transfer, so other terms are a 422.
      return {
        fingerprint: existing.idempotency_fingerprint,
        respond: () => replayTransferRow(c, existing),
      };
    }
    if (
      existing.idempotency_key !== recordKey &&
      existing.custody_wallet_id === operation.sourceWallet.id &&
      existing.destination_address === body.destination &&
      existing.token === operation.token &&
      existing.amount !== null &&
      compareDecimalAmounts(existing.amount, operation.amount) === 0
    ) {
      // Another request funded it: answered with the deposit it asked for.
      return { fingerprint: null, respond: () => replayTransferRow(c, existing) };
    }
    return null;
  }

  const row = await getPaymentsRepository(c).findTransferByIdempotency({
    organizationId: scope.auth.organizationId,
    projectId: requireProjectId(c),
    idempotencyKey: recordKey,
  });
  if (row === null || row.idempotency_fingerprint === null) return null;
  return { fingerprint: row.idempotency_fingerprint, respond: () => replayTransferRow(c, row) };
}

async function updateTransferRecord(
  c: AppContext,
  transfer: TransferRow,
  patch: {
    /** Where a wallet send lands; a funded off-ramp deposit takes its ramp transition instead. */
    status: keyof typeof OFFRAMP_DEPOSIT_OUTCOME_TRANSITIONS;
    signature?: string | null;
    serializedTx?: string | null;
    slot?: number | null;
    blockTime?: string | null;
    fee?: number | null;
    error?: string | null;
    /** The error code the request is answered with, kept for a replay of a failed row. */
    failureCode?: ErrorCode;
  }
): Promise<
  { outcome: "updated"; row: TransferRow } | { outcome: "settled_concurrently"; row: TransferRow }
> {
  const repository = getPaymentsRepository(c);
  const change = {
    transferId: transfer.id,
    organizationId: transfer.organization_id,
    projectId: transfer.project_id,
    signature: patch.signature,
    serializedTx: patch.serializedTx,
    slot: patch.slot,
    blockTime: patch.blockTime,
    fee: patch.fee,
    error: patch.error,
    providerData:
      patch.failureCode === undefined ? undefined : executionFailureData(patch.failureCode),
    updatedAt: new Date().toISOString(),
  };

  const updated = isRampTransferType(transfer.type)
    ? await repository.transitionRampTransfer({
        ...change,
        transition: OFFRAMP_DEPOSIT_OUTCOME_TRANSITIONS[patch.status],
      })
    : await repository.updateTransfer({
        ...change,
        expectedStatus: "processing",
        status: patch.status,
      });

  if (updated) {
    return { outcome: "updated", row: updated };
  }
  if (!isRampTransferType(transfer.type) && patch.status === "finalized") {
    const upgraded = await repository.updateTransfer({
      ...change,
      expectedStatus: "confirmed",
      status: "finalized",
    });
    if (upgraded) {
      return { outcome: "updated", row: upgraded };
    }
  }

  const current = await repository.getTransferById({
    transferId: transfer.id,
    organizationId: transfer.organization_id,
    projectId: transfer.project_id,
  });
  if (!current) {
    throw internalError("Payment transfer record not found for update");
  }

  return { outcome: "settled_concurrently", row: current };
}

function resolveTransferUpdateResult(
  result: Awaited<ReturnType<typeof updateTransferRecord>>
): TransferRow {
  if (result.outcome === "updated") return result.row;
  if (TRANSFER_CHAIN_VERDICT_STATUSES.some((status) => status === result.row.status)) {
    return result.row;
  }
  throw conflict("Payment transfer was concurrently updated without a chain verdict");
}

/** A chain verdict or preflight simulation proves this exact transaction cannot land. */
function isDefiniteExecutionFailure(error: unknown): boolean {
  return (
    isDefiniteSubmissionError(error) || mapTransferExecutionError(error).code === "ACCOUNT_FROZEN"
  );
}

function logSubmittedUnconfirmed(transfer: TransferRow, signature: string | null, error: unknown) {
  logEvent("warn", {
    event: "sdp_api_payment_submission_unresolved",
    flow: "single",
    reason: "submission_unconfirmed",
    organization_id: transfer.organization_id,
    project_id: transfer.project_id,
    transfer_id: transfer.id,
    transfer_type: transfer.type,
    signature,
    error: error instanceof Error ? error.message : String(error),
  });
}

/**
 * An off-ramp deposit that failed before SDP recorded signed bytes moved
 * nothing, so its sale goes back to awaiting the deposit instead of failing.
 * False when the row holds anything a broadcast could have used.
 */
async function releaseUnsentRampDeposit(
  c: AppContext,
  transfer: TransferRow,
  cause: unknown
): Promise<boolean> {
  if (transfer.type !== "offramp") return false;
  const released = await getPaymentsRepository(c).releaseOfframpDepositClaim({
    transferId: transfer.id,
    organizationId: transfer.organization_id,
    projectId: transfer.project_id,
    updatedAt: new Date().toISOString(),
  });
  if (released === null) return false;
  markIdempotencyReleased(c);
  logEvent("warn", {
    event: "sdp_api_ramp_deposit_released",
    provider: transfer.provider,
    organization_id: transfer.organization_id,
    project_id: transfer.project_id,
    transfer_id: transfer.id,
    ...describeError(cause),
  });
  return true;
}

/**
 * A failure after the durable start marker remains processing for chain
 * reconciliation, and the request answers with the row as it stands now, so a
 * verdict reconciliation already wrote is what the caller sees (APE-892): a
 * success closes the audit intent like a concurrent verdict, and a failure
 * answers exactly as a later replay of the row would.
 * Before that marker, no broadcast was possible and the
 * transfer can fail normally; an unsigned off-ramp deposit is released.
 */
async function settleTransferExecutionFailure(
  c: AppContext,
  transfer: TransferRow,
  recorder: { submittedRow(): Promise<TransferRow | null> },
  error: unknown,
  toPayload: (row: TransferRow) => Promise<Record<string, unknown>>,
  onConcurrentChainVerdict?: (settled: TransferRow) => Promise<void>
): Promise<Response> {
  const submitted = await recorder.submittedRow();
  if (submitted && !isDefiniteExecutionFailure(error)) {
    logSubmittedUnconfirmed(transfer, submitted.signature, error);
    const current = await getPaymentsRepository(c).getTransferById({
      transferId: transfer.id,
      organizationId: transfer.organization_id,
      projectId: transfer.project_id,
    });
    if (!current) {
      throw internalError("Payment transfer record not found after submission");
    }
    if (current.status === "failed") {
      throw failedTransferError(current);
    }
    if (isSuccessfulPaymentTransferStatus(current.status)) {
      await onConcurrentChainVerdict?.(current);
    }
    return success(c, await toPayload(current));
  }
  const message = error instanceof Error ? error.message : "Unknown transfer error";
  const answer = mapTransferExecutionError(error);
  if (submitted === null && (await releaseUnsentRampDeposit(c, transfer, error))) {
    throw answer;
  }
  const settled = resolveTransferUpdateResult(
    await updateTransferRecord(c, transfer, {
      status: "failed",
      error: message,
      signature: submitted?.signature,
      blockTime: null,
      // A replay of the row answers with this same error (HOO-1918).
      failureCode: answer.code,
    })
  );
  if (settled.status !== "failed") {
    await onConcurrentChainVerdict?.(settled);
    return success(c, await toPayload(settled));
  }
  throw answer;
}

/**
 * Maps a transfer execution failure to the `AppError` the route should
 * surface. `AppError`s thrown deeper in the stack (e.g. on-chain confirmation
 * failures) pass through unchanged. Failures whose message carries the SPL
 * Token / Token-2022 `AccountFrozen` program error — Kora surfaces simulation
 * rejections as `custom program error: 0x11` (decimal code 17), the hex form
 * from the JSON-RPC preflight response, not `@solana/kit`'s own decimal `#17`
 * `SolanaError` formatting — are surfaced as the existing 400 `ACCOUNT_FROZEN`
 * error instead of an opaque 502; anything else falls back to the generic
 * `SOLANA_RPC_ERROR`.
 */
export function mapTransferExecutionError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }
  const message = error instanceof Error ? error.message : "Unknown transfer error";
  const programErrorCode = /custom program error: (0x[0-9a-f]+)/i.exec(message)?.[1].toLowerCase();
  return programErrorCode === "0x11" ? accountFrozen(message) : solanaRpcError(message);
}

async function executeSponsoredTransfer(
  c: AppContext,
  params: {
    sourceWallet: CustodyWallet;
    submissionStore: SignedSubmissionStore;
    landingStatus: TransferLandingStatus;
    buildInstructions: (context: {
      signer: TransactionSigner;
      feePayer: Address;
    }) => readonly Instruction[];
  }
): Promise<{ signature: string; slot: number | null; blockTime: string | null }> {
  const auth = getAuth(c);
  const signer = await createOrgSignerForCustodyWallet(
    c.env,
    auth.organizationId,
    requireProjectId(c),
    params.sourceWallet.id,
    "payments.transfer"
  );

  if (signer.address !== params.sourceWallet.publicKey) {
    throw badRequest("Resolved signing wallet does not match source wallet");
  }

  const rpc = createClusterRpc();
  const feePayment = createSponsorshipFeePayment(
    c.env,
    resolveRequestSponsorshipScope(c),
    "payments.transfer",
    { custodyWalletId: params.sourceWallet.id }
  );
  const feePayer = await feePayment.getFeePayer();
  const instructions = params.buildInstructions({ signer, feePayer });
  const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(rpc, "confirmed");

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
    (m) => addSignersToTransactionMessage([signer], m)
  );

  const partiallySigned = await signWithFreshBlockhash({
    blockhash,
    sign: () => partiallySignTransactionMessageWithSigners(message),
  });
  const txEncoder = getTransactionEncoder();
  const txBytes = new Uint8Array(txEncoder.encode(partiallySigned));
  const signature = await submitSponsoredTransaction({
    feePayment,
    rpc,
    transaction: txBytes,
    lastValidBlockHeight,
    store: params.submissionStore,
  });

  const confirmation = await confirmTransaction(rpc, signature, {
    commitment: params.landingStatus,
  });

  if (confirmation.err) {
    throw transactionFailed("Transfer failed on-chain");
  }

  return {
    signature,
    slot: Number(confirmation.slot),
    blockTime: null,
  };
}

/**
 * Signs and sends the one transfer a plan builds, through the custody signer
 * and the fee sponsor (ADR 0007). The plan was read and quoted before the row
 * was written, so building reads nothing.
 */
async function executePlannedTransfer(
  c: AppContext,
  sourceWallet: CustodyWallet,
  plan: PlannedTokenMovement,
  submissionStore: SignedSubmissionStore,
  landingStatus: TransferLandingStatus
): Promise<{ signature: string; slot: number | null; blockTime: string | null }> {
  const leg = singleLeg(plan);
  return executeSponsoredTransfer(c, {
    sourceWallet,
    submissionStore,
    landingStatus,
    buildInstructions: ({ signer, feePayer }) =>
      buildPlannedLeg(plan, leg, { authority: signer, feePayer }),
  });
}

/** A transfer as the API answers with it: the row with its legs' amounts and verification. */
async function transferWithLegs(c: AppContext, row: TransferRow) {
  const legs = await getTokenMovementLegsRepository(c).listLegsByTransfers([row.id]);
  // A row written before quotes has no leg (legacy = no leg).
  return mapTransferWithLegs(row, legs.get(row.id) ?? []);
}

async function transferPayload(c: AppContext, row: TransferRow) {
  return { transfer: await transferWithLegs(c, row) };
}

/** Where a failed transfer keeps the error code its request was answered with. */
const EXECUTION_FAILURE_KEY = "executionFailure";

function executionFailureData(code: ErrorCode): Record<string, unknown> {
  return { [EXECUTION_FAILURE_KEY]: { code } };
}

/**
 * Answers a request from the transfer row its key wrote (HOO-1918). A failed
 * transfer answers with the error its request got (the same status and code),
 * never a 200: the key is spent on that failure, so the message says to retry
 * with a new Idempotency-Key.
 */
async function replayTransferRow(c: AppContext, row: TransferRow): Promise<Response> {
  if (row.status !== "failed") {
    return success(c, await transferPayload(c, row));
  }
  // Returned, not thrown: replayFromRecord marks the Response the finder builds.
  return appErrorResponse(c, failedTransferError(row));
}

/**
 * The error a failed transfer row answers with: the code its request recorded,
 * or `TRANSACTION_FAILED` for a row the reconciler failed from the chain.
 *
 * @param row - A transfer row whose status is `failed`.
 * @returns The error a replay of the row's key answers with.
 */
function failedTransferError(row: TransferRow): AppError {
  const recorded = row.provider_data[EXECUTION_FAILURE_KEY];
  const recordedCode =
    typeof recorded === "object" && recorded !== null && "code" in recorded
      ? recorded.code
      : undefined;
  // A row the reconciler failed from the chain records no code: it is a
  // transaction failure.
  const code = isErrorCode(recordedCode) ? recordedCode : "TRANSACTION_FAILED";
  return new AppError(
    code,
    `${row.error ?? "The transfer failed"}. This Idempotency-Key belongs to a transfer that failed; send the request again with a new Idempotency-Key to try again.`,
    { transferId: row.id, status: row.status }
  );
}

function transferMatchesSearch(row: TransferRow, search: string): boolean {
  const normalizedSearch = search.toLowerCase();
  return [
    row.id,
    row.signature,
    row.provider_reference,
    row.source_address,
    row.destination_address,
    row.memo,
    row.counterparty_id,
    row.counterparty_display_name,
  ].some((value) => value?.toLowerCase().includes(normalizedSearch));
}

function compareTransferRows(
  left: TransferRow,
  right: TransferRow,
  sortBy: "amount" | "createdAt" | "status" | "updatedAt",
  sortDirection: "asc" | "desc"
): number {
  let primaryComparison: number;

  if (sortBy === "amount") {
    const leftAmount = left.amount?.trim() || null;
    const rightAmount = right.amount?.trim() || null;
    if (leftAmount === null || rightAmount === null) {
      if (leftAmount === rightAmount) {
        primaryComparison = 0;
      } else {
        return leftAmount === null ? 1 : -1;
      }
    } else {
      primaryComparison = compareDecimalAmounts(leftAmount, rightAmount);
    }
  } else if (sortBy === "status") {
    primaryComparison = left.status.localeCompare(right.status);
  } else if (sortBy === "updatedAt") {
    primaryComparison = left.updated_at.localeCompare(right.updated_at);
  } else {
    primaryComparison = left.created_at.localeCompare(right.created_at);
  }

  if (primaryComparison !== 0) {
    return sortDirection === "asc" ? primaryComparison : -primaryComparison;
  }

  const createdAtComparison = right.created_at.localeCompare(left.created_at);
  return createdAtComparison || right.id.localeCompare(left.id);
}

async function executeFireblocksTransfer(
  c: AppContext,
  transfer: TransferRow,
  auditService: AuditService,
  auditIntent: Awaited<ReturnType<AuditService["beginCritical"]>>
) {
  // Once claimed, an ambiguous provider response must never enter the local
  // transaction failure/rebroadcast path. The durable provider intent owns recovery.
  let updated: TransferRow;
  try {
    updated = await submitFireblocksTransfer(c.env, getPaymentsRepository(c), transfer);
  } catch (error) {
    await auditService.completeCritical(c, auditIntent, {
      status: "failure",
      metadata: { status: "failed" },
    });
    throw error;
  }
  if (updated.provider_reference || updated.status === "failed") {
    await auditService.completeCritical(c, auditIntent, {
      status: updated.status === "failed" ? "failure" : "success",
      metadata: { fireblocksTransactionId: updated.provider_reference, status: updated.status },
    });
  }
  if (updated.status === "failed")
    throw transactionFailed(updated.error ?? "Fireblocks refused the transfer");
  return success(c, await transferPayload(c, updated));
}

/**
 * POST /transfers. The movement is read, gated and quoted before its row is
 * written, so a refusal (an amount the mint cannot hold, a paused mint) costs
 * no Idempotency-Key; the row and its leg are then written together, and the
 * transfer is built from the plan, signed and sent.
 */
export async function createTransfer(c: ValidatedBodyContext<typeof createTransferSchema>) {
  const body = c.req.valid("json");
  const { scope, operation, basis, rampTransfer } = getAuthorized<TransferResolved>(c);
  // The credential-bound record key (ADR 0009), never the raw client key.
  const recordKey = getIdempotencyRecordKey(c);
  const fingerprint = getIdempotencyFingerprint(c);
  const idempotency =
    recordKey !== undefined && fingerprint !== undefined ? { key: recordKey, fingerprint } : null;
  const fireblocks = await prepareFireblocksTransfer(
    c.env,
    scope.auth.organizationId,
    requireProjectId(c),
    operation
  );
  // Unsupported Fireblocks mints are refused above, before the planner reads the chain; the plan
  // refuses a too-precise amount before the row, so it is the caller's 400, never a failed transfer.
  if (fireblocks && body.transferId)
    throw badRequest("Fireblocks native transfers currently support direct wallet payments only");

  let transfer: TransferRow;
  let plan: PlannedTokenMovement;
  if (rampTransfer) {
    const claimed = await updateOnchainTransferForRamp(c, {
      existing: rampTransfer,
      scope,
      operation,
      basis,
      destinationAddress: body.destination,
      memo: body.memo ?? null,
      idempotency,
    });
    transfer = claimed.row;
    plan = claimed.plan;
  } else {
    plan = await planTokenMovement({
      asset: operation.asset,
      basis,
      source: operation.sourceAddress,
      destinations: [{ owner: operation.destinationAddress, amount: operation.amount }],
      memo: body.memo ?? null,
    });
    const created = await createTransferRecord(c, {
      organizationId: scope.auth.organizationId,
      projectId: requireProjectId(c),
      custodyWalletId: operation.sourceWallet.id,
      walletId: operation.sourceWallet.walletId,
      sourceAddress: operation.sourceWallet.publicKey,
      destinationAddress: body.destination,
      token: operation.token,
      quote: singleLeg(plan).quote,
      memo: body.memo,
      status: "processing",
      initiatedByKeyId: scope.auth.id,
      idempotency,
      providerData: fireblocks ? { fireblocksTransfer: fireblocks.intent } : undefined,
    });
    if (created.replayed) {
      return replayTransferRow(c, created.row);
    }
    transfer = created.row;
  }
  // The row exists under the key: from here every answer is the request's own,
  // stored for its retries even when it is a 400 or 409.
  markIdempotencyCommitted(c);

  const submissionStore = createTransferSignedSubmissionStore(getPaymentsRepository(c), transfer);
  const landingStatus = transferLandingStatus(transfer.type);
  // The tamper-evident ledger admits the movement before any bytes can reach
  // the chain; a submission whose confirmation never lands leaves the intent
  // unresolved, which is exactly the state reconciliation pages on.
  const auditService = new AuditService(getDb(c.env));
  let auditIntent: Awaited<ReturnType<AuditService["beginCritical"]>>;
  try {
    auditIntent = await auditService.beginCritical(c, {
      action: "transfer",
      resourceType: "payment_transfer",
      resourceId: transfer.id,
      metadata: {
        custodyWalletId: operation.sourceWallet.id,
        walletId: operation.sourceWallet.walletId,
        sourceAddress: operation.sourceWallet.publicKey,
        destination: body.destination,
        // Named tokenMint: a bare "token" key is scrubbed as a credential by
        // the audit redaction policy, and a mint address is not a secret.
        tokenMint: operation.token,
        amount: operation.amount,
        amountBasis: basis,
      },
    });
  } catch (error) {
    // Nothing was broadcast, but the processing row is already durable and an
    // idempotent retry would replay it as if it had executed. Settle it failed
    // so the ledger refusal cannot mint an unaudited, replayable transfer; an
    // off-ramp deposit goes back to awaiting it instead.
    if (await releaseUnsentRampDeposit(c, transfer, error)) throw error;
    await updateTransferRecord(c, transfer, {
      status: "failed",
      error: "Audit ledger admission failed before execution",
      failureCode: error instanceof AppError ? error.code : "INTERNAL_ERROR",
    });
    throw error;
  }
  if (fireblocks) return executeFireblocksTransfer(c, transfer, auditService, auditIntent);
  try {
    const result = await executePlannedTransfer(
      c,
      operation.sourceWallet,
      plan,
      submissionStore,
      landingStatus
    );
    const updated = resolveTransferUpdateResult(
      await updateTransferRecord(c, transfer, {
        status: landingStatus,
        signature: result.signature,
        slot: result.slot,
        blockTime: result.blockTime,
        error: null,
      })
    );
    await auditService.completeCritical(c, auditIntent, {
      metadata: { signature: result.signature, slot: result.slot?.toString() ?? null },
    });

    return success(c, await transferPayload(c, updated));
  } catch (error) {
    try {
      return await settleTransferExecutionFailure(
        c,
        transfer,
        submissionStore,
        error,
        (row) => transferPayload(c, row),
        async (settled) => {
          // A concurrent writer (reconciliation, a replayed submission) already
          // proved the chain outcome; the intent resolves with that verdict
          // instead of dangling on an operation whose result is known.
          if (isSuccessfulPaymentTransferStatus(settled.status)) {
            await auditService.completeCritical(c, auditIntent, {
              metadata: { signature: settled.signature, slot: settled.slot?.toString() ?? null },
            });
          }
        }
      );
    } catch (settledError) {
      await auditService.completeCritical(c, auditIntent, {
        status: "failure",
        metadata: { error: error instanceof Error ? error.message : "Unknown transfer error" },
      });
      throw settledError;
    }
  }
}

/** In-memory equivalents of listTransfers' SQL filters, for merged rows. */
function transferRowMatchesFilters(
  row: TransferRow,
  filters: {
    search: string | undefined;
    counterpartyId: string | undefined;
    provider: string | undefined;
    statuses: readonly TransferStatus[] | undefined;
    token: string | undefined;
    direction: TransferDirection | undefined;
    types: ReadonlySet<TransferType> | undefined;
    from: string | undefined;
    to: string | undefined;
  }
): boolean {
  if (filters.search && !transferMatchesSearch(row, filters.search)) return false;
  if (filters.counterpartyId && row.counterparty_id !== filters.counterpartyId) return false;
  if (filters.provider && row.provider !== filters.provider) return false;
  if (filters.statuses && !filters.statuses.includes(row.status)) return false;
  if (filters.token && row.token !== filters.token) return false;
  if (filters.direction && row.direction !== filters.direction) return false;
  if (filters.types && !filters.types.has(row.type)) return false;
  if (filters.from && row.created_at < filters.from) return false;
  if (filters.to && row.created_at > filters.to) return false;
  return true;
}

interface ObservedTransferTarget {
  sourceAddress: string;
  custodyWalletId: string;
  resolvedWalletId: string;
  walletIdsByAddress: Map<string, string>;
}

function observedTransferTarget(wallet: CustodyWallet): ObservedTransferTarget {
  return {
    sourceAddress: wallet.publicKey,
    custodyWalletId: wallet.id,
    resolvedWalletId: wallet.walletId,
    walletIdsByAddress: new Map([[wallet.publicKey, wallet.walletId]]),
  };
}

/**
 * The read that shows each type of transfer row, as the unified feed asks
 * for each kind: a ramp or batch row is that module's record, so
 * `transfers.read` alone does not show it (HOO-2099).
 */
const TRANSFER_TYPE_READ_ACTIONS = {
  transfer: "transfers.read",
  transfer_batch: "transfer_batches.read",
  onramp: "onramp.read",
  offramp: "offramp.read",
} as const satisfies Record<TransferType, Action>;

/**
 * Whether this deployment discloses transfers of `type`: a ramp transfer only
 * while the release channel runs Ramps (APE SOLA9-698).
 */
function isTransferTypeInChannel(c: AppContext, type: TransferType): boolean {
  return !isRampTransferType(type) || isModuleInChannel(c, "ramps");
}

/**
 * The transfer types this caller may list: an explicitly requested type it
 * cannot read, or whose module the release channel leaves out, is refused; a
 * category or the default set is narrowed to what it can read.
 */
function readableTransferTypes(
  c: AppContext,
  requested: readonly TransferType[] | undefined,
  candidates: readonly TransferType[]
): TransferType[] {
  if ((requested ?? []).some((type) => !isTransferTypeInChannel(c, type))) {
    assertModuleInChannel(c, "ramps");
  }
  const unreadable = (requested ?? []).find(
    (type) => !callerMayPerform(c, TRANSFER_TYPE_READ_ACTIONS[type])
  );
  if (unreadable) {
    const action = TRANSFER_TYPE_READ_ACTIONS[unreadable];
    throw missingAction(action);
  }
  return candidates.filter(
    (type) =>
      isTransferTypeInChannel(c, type) && callerMayPerform(c, TRANSFER_TYPE_READ_ACTIONS[type])
  );
}

export async function listTransfers(c: AppContext) {
  const auth = getAuth(c);
  const query = listTransfersQuerySchema.safeParse(c.req.query());
  if (!query.success) throw badRequestQuery();
  const {
    page,
    pageSize,
    custodyWalletId,
    search,
    token,
    direction,
    status: statuses,
    category,
    type: requestedTypes,
    counterpartyId,
    provider,
    providerReference,
    from,
    to,
    includeObserved,
    sortBy,
    sortDirection,
  } = query.data;
  const repo = getPaymentsRepository(c);
  const offset = (page - 1) * pageSize;
  const categoryTypes =
    category === "wallet"
      ? WALLET_TRANSFER_TYPES
      : category === "ramp"
        ? RAMP_TRANSFER_TYPES
        : undefined;
  if (
    requestedTypes &&
    categoryTypes &&
    requestedTypes.some((type) => !categoryTypes.includes(type as never))
  ) {
    throw badRequest("type must match the requested transfer category");
  }
  if (category === "ramp") {
    assertModuleInChannel(c, "ramps");
  }
  const transferTypes = readableTransferTypes(
    c,
    requestedTypes,
    requestedTypes ?? categoryTypes ?? PAYMENT_TRANSFER_TYPES
  );
  // Nothing readable is an empty page, never an absent filter: the
  // repository reads an empty type list as no condition at all.
  if (transferTypes.length === 0) {
    return paginated(c, [], { total: 0, page, pageSize });
  }
  const transferTypeSet = new Set<TransferType>(transferTypes);
  // Rows store mints, so a symbol or native-SOL filter must be normalized to
  // the same canonical mint before either the in-memory or SQL comparison.
  const tokenFilter = token ? normalizePaymentToken(token) : undefined;
  const hasProvider = provider !== undefined;
  const hasProviderReference = providerReference !== undefined;
  const hasExactProviderReference = hasProvider && hasProviderReference;

  let exactWallet: CustodyWallet | null = null;
  if (custodyWalletId) {
    if (includeObserved) {
      const scope = await resolveScope(c);
      exactWallet = resolveWalletByCustodyWalletId(scope.wallets, custodyWalletId);
    }
  }

  if (includeObserved && !exactWallet) {
    throw badRequest("custodyWalletId is required when includeObserved=true");
  }

  if (hasProviderReference && !hasProvider) {
    throw badRequest("provider is required for provider reference lookup");
  }

  let transferRows: TransferRow[];
  let total: number;

  // On-chain history is opt-in and always anchored to one exact wallet row.
  const observedTarget =
    exactWallet && includeObserved && !hasExactProviderReference
      ? observedTransferTarget(exactWallet)
      : null;

  if (observedTarget) {
    // On-chain path: fetch signatures for the wallet address on the project's cluster, then
    // cross-reference with our DB. Append pending/processing/failed from DB (not on-chain yet).
    //
    // TODO: Replace getSignaturesForAddress with a dedicated indexer for production use.

    // Metered per tenant and actor, failing closed: this path fans out to the
    // billed RPC and must not run unmetered through a limiter outage.
    await enforceMeteredQuota(c, { name: "observed-transfers", actorMax: 30, orgMax: 120 });

    const {
      sourceAddress,
      custodyWalletId: observedCustodyWalletId,
      resolvedWalletId,
      walletIdsByAddress,
    } = observedTarget;

    // 1. Fetch on-chain signature history.
    // The owner-address history, the wallet's token accounts, and the persisted
    // ledger query are independent reads, so they start together instead of
    // paying each round-trip serially; only the token-account signature sweeps
    // below need to wait for the token accounts.
    const historyRpc = createClusterHistoryRpc();
    const ownerAddress = address(sourceAddress);
    const historyLimit = Math.min(pageSize * 5, 200);
    const signatureSearchAddresses: Address[] = [ownerAddress];

    // 2. Load the exact persisted ledger. Fetching the first N persisted rows
    // is sufficient for page N after observed rows are merged: observations
    // can only push persisted rows later in the combined ordering.
    const persistedResultPromise = repo.listTransfers({
      organizationId: auth.organizationId,
      projectId: requireProjectId(c),
      custodyWalletId: observedCustodyWalletId,
      counterpartyId,
      search,
      token: tokenFilter,
      direction,
      statuses,
      types: transferTypes,
      provider,
      createdAtFrom: from,
      createdAtTo: to,
      sortBy,
      sortDirection,
      limit: offset + pageSize,
      offset: 0,
    });

    const [ownerSignatures, tokenAccountAddresses, persistedResult] = await Promise.all([
      getSignaturesForAddress(historyRpc, ownerAddress, {
        limit: historyLimit,
        commitment: "confirmed",
      }),
      resolveWalletTokenAccountAddresses(c, historyRpc, ownerAddress, resolvedWalletId),
      persistedResultPromise,
    ]);

    for (const tokenAccountAddress of tokenAccountAddresses) {
      walletIdsByAddress.set(tokenAccountAddress, resolvedWalletId);

      if (
        signatureSearchAddresses.length <= MAX_TOKEN_ACCOUNT_SIGNATURE_LOOKUPS &&
        !signatureSearchAddresses.some(
          (searchAddress) => String(searchAddress) === String(tokenAccountAddress)
        )
      ) {
        signatureSearchAddresses.push(tokenAccountAddress);
      }
    }

    if (tokenAccountAddresses.length > MAX_TOKEN_ACCOUNT_SIGNATURE_LOOKUPS) {
      getLogger().info(
        {
          event: "sdp_api_signature_search_truncated",
          wallet_id: resolvedWalletId,
          token_accounts: tokenAccountAddresses.length,
          searched: signatureSearchAddresses.length - 1,
        },
        "Token-account signature search truncated to cap"
      );
    }

    const tokenAccountSignatureResults = await mapSettledWithConcurrency(
      signatureSearchAddresses.slice(1),
      SIGNATURE_HISTORY_LOOKUP_CONCURRENCY,
      (searchAddress) =>
        getSignaturesForAddress(historyRpc, searchAddress, {
          limit: historyLimit,
          commitment: "confirmed",
        })
    );
    const tokenAccountSignatures = tokenAccountSignatureResults.flatMap((result) =>
      result.status === "fulfilled" ? result.value : []
    );
    const onChainSigs = dedupeSignatureHistory(
      [...ownerSignatures, ...tokenAccountSignatures],
      historyLimit
    );
    const sigStrings = onChainSigs.map((s) => String(s.signature));

    // 3. Look up every observed signature in our DB before synthesizing rows.
    // A persisted exact row remains authoritative even when it falls outside
    // the requested page or filters.
    const persistedSignatureRows = await repo.listTransfersBySignatures({
      signatures: sigStrings,
      organizationId: auth.organizationId,
      projectId: requireProjectId(c),
    });
    const scopedPersistedSignatureRows = persistedSignatureRows.filter(
      (row) => row.custody_wallet_id === observedCustodyWalletId
    );

    const persistedSignatures = new Set(
      scopedPersistedSignatureRows
        .map((row) => row.signature)
        .filter((rowSignature): rowSignature is string => Boolean(rowSignature))
    );
    const missingObservedSignatures = onChainSigs.filter(
      (signatureInfo) => !persistedSignatures.has(String(signatureInfo.signature))
    );
    const observedRows = await buildObservedTransfersForSignatures(missingObservedSignatures, {
      organizationId: auth.organizationId,
      projectId: requireProjectId(c),
      walletIdsByAddress,
    });

    // 4. Filter only synthetic observations; the repository already applied
    // the same filters to the authoritative exact ledger.
    const filteredObservedRows = observedRows.filter((row) =>
      transferRowMatchesFilters(row, {
        search,
        counterpartyId,
        provider,
        statuses,
        token: tokenFilter,
        direction,
        types: transferTypeSet,
        from,
        to,
      })
    );

    // 5. Merge the exact ledger with only missing observations, then paginate.
    const merged = [...persistedResult.rows, ...filteredObservedRows].sort((left, right) =>
      compareTransferRows(left, right, sortBy, sortDirection)
    );

    total = persistedResult.total + filteredObservedRows.length;
    transferRows = merged.slice(offset, offset + pageSize);
  } else {
    // DB-only path: exact rows are filtered by the canonical SDP Wallet ID.
    const queryStartedAt = performance.now();
    const result = await repo.listTransfers({
      organizationId: auth.organizationId,
      projectId: requireProjectId(c),
      custodyWalletId,
      counterpartyId,
      search,
      token: tokenFilter,
      direction,
      statuses,
      types: transferTypes,
      provider,
      providerReference,
      createdAtFrom: from,
      createdAtTo: to,
      sortBy,
      sortDirection,
      limit: pageSize,
      offset,
    });
    c.header("Server-Timing", `db;dur=${(performance.now() - queryStartedAt).toFixed(1)}`, {
      append: true,
    });
    total = result.total;
    transferRows = result.rows;
  }

  // Reconcile only a bounded slice; independent reads share a 15s durable poll claim.
  const pending = transferRows
    .filter((row) => isFireblocksTransfer(row) && row.status === "processing")
    .slice(0, 4);
  const refreshed = await mapSettledWithConcurrency(pending, 4, (row) =>
    refreshFireblocksTransfer(c.env, repo, row)
  );
  const byId = new Map(
    refreshed.flatMap((result) =>
      result.status === "fulfilled" ? [[result.value.id, result.value] as const] : []
    )
  );
  transferRows = transferRows.map((row) => byId.get(row.id) ?? row);
  const legs = await getTokenMovementLegsRepository(c).listLegsByTransfers(
    transferRows.map((row) => row.id)
  );
  // A row written before quotes, or observed on chain, has no leg (legacy = no leg).
  const transfers = transferRows.map((row) => mapTransferWithLegs(row, legs.get(row.id) ?? []));
  return paginated(c, transfers, { total, page, pageSize });
}

export async function getTransfer(c: AppContext) {
  const auth = getAuth(c);
  const params = transferIdParamsSchema.safeParse(c.req.param());
  const repo = getPaymentsRepository(c);

  if (!params.success) throw badRequest("Transfer ID is required");

  const row = await repo.getTransferById({
    transferId: params.data.transferId,
    organizationId: auth.organizationId,
    projectId: requireProjectId(c),
  });

  // A row of a module the caller cannot read, or the release channel leaves out, is not disclosed.
  if (
    !row ||
    !isTransferTypeInChannel(c, row.type) ||
    !callerMayPerform(c, TRANSFER_TYPE_READ_ACTIONS[row.type])
  ) {
    throw notFound("Transfer");
  }

  const refreshed = await refreshFireblocksTransfer(c.env, repo, row);
  return success(c, await transferPayload(c, refreshed));
}
