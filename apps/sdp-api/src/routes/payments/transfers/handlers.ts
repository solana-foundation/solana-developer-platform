import { compareDecimalAmounts } from "@sdp/payments/decimal";
// biome-ignore lint/style/noRestrictedImports: the transfers list reads wallet signature history through the Helius-first pool
import { createClusterHistoryRpc, createClusterRpc } from "@sdp/rpc/factory";
import {
  confirmTransaction,
  getRecentBlockhash,
  getSignaturesForAddress,
  type SolanaRpc,
} from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { parseDecimalAmount } from "@sdp/solana/amount";
import {
  isSuccessfulPaymentTransferStatus,
  RAMP_TRANSFER_TYPES,
  TRANSFER_CHAIN_VERDICT_STATUSES,
  type PaymentTransferStatus as TransferStatus,
  type PaymentTransferType as TransferType,
  WALLET_TRANSFER_TYPES,
} from "@sdp/types/payments";
import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import {
  address,
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { partiallySignTransactionMessageWithSigners } from "@solana/signers";
import { getTransferSolInstruction } from "@solana-program/system";
import { z } from "zod";
import { getDb } from "@/db/client";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import {
  generatePaymentTransferId,
  type PaymentTransferDirection as TransferDirection,
  type PaymentTransferRow as TransferRow,
} from "@/db/repositories/payments.repository";
import { createPostgresPaymentsRepository } from "@/db/repositories/payments.repository.postgres";
import { getAuth, requireProjectId } from "@/lib/auth";
import { mapSettledWithConcurrency } from "@/lib/concurrency";
import {
  AppError,
  accountFrozen,
  badRequest,
  badRequestQuery,
  conflict,
  type ErrorCode,
  forbidden,
  internalError,
  isErrorCode,
  notFound,
  solanaRpcError,
  transactionFailed,
} from "@/lib/errors";
import { appErrorResponse, paginated, success } from "@/lib/response";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import { type AuthorizeInput, getAuthorized } from "@/middleware/authorize";
import {
  getIdempotencyFingerprint,
  getIdempotencyRecordKey,
  markIdempotencyCommitted,
  markIdempotencyRecordMismatch,
} from "@/middleware/idempotency";
import { enforceMeteredQuota } from "@/middleware/metered-quota";
import type { MovementStepInput, RecordAnswer } from "@/middleware/movement-steps";
import { assertTransferRampProviderInChannel } from "@/middleware/require-module";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { buildSplTransferInstructions } from "@/routes/payments/token-accounts";
import { getLogger } from "@/runtime/logger";
import { logEvent } from "@/runtime/money-path-events";
import { getAllowedApiKeyWalletAuthorizationForPermissions } from "@/services/api-key-scope.service";
import { AuditService } from "@/services/audit.service";
import {
  assertPaymentProjectScope,
  isNativePaymentToken,
  normalizePaymentToken,
  type OutboundPaymentOperation,
  resolveOutboundPaymentOperation,
} from "@/services/payment-operation.service";
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
import { type AppContext, getPaymentsRepository } from "../context";
import { mapTransferRow } from "../mappers";
import { transferIdParamsSchema } from "../schemas";
import {
  admitPaymentWalletRuntimeExecution,
  assertPaymentWalletReadAccess,
  authorizeCustodyPaymentWallet,
  type ResolvedScope,
  resolveScope,
  resolveWalletByCustodyWalletId,
} from "../wallets";
import {
  buildObservedTransfersForSignatures,
  dedupeSignatureHistory,
  MAX_TOKEN_ACCOUNT_SIGNATURE_LOOKUPS,
  resolveWalletTokenAccountAddresses,
  SIGNATURE_HISTORY_LOOKUP_CONCURRENCY,
} from "./observed-transfers";
import { type createTransferSchema, listTransfersQuerySchema } from "./schemas";

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
    amount: string;
    memo?: string;
    type?: TransferType;
    direction?: TransferDirection;
    status?: TransferStatus;
    serializedTx?: string;
    initiatedByKeyId?: string;
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
    const db = getDb(c.env);
    const repository = createPostgresPaymentsRepository(db, getRequestTenantScope(c));

    const createdRow = await repository.createTransfer({
      id: generatePaymentTransferId(),
      organizationId: input.organizationId,
      projectId: input.projectId,
      custodyWalletId: input.custodyWalletId,
      walletId: input.walletId,
      counterpartyId: null,
      sourceAddress: input.sourceAddress,
      destinationAddress: input.destinationAddress,
      token: input.token,
      amount: input.amount,
      memo: input.memo ?? null,
      type: input.type ?? "transfer",
      direction: input.direction ?? "outbound",
      status: input.status ?? "pending",
      provider: null,
      providerReference: null,
      deliveryMode: null,
      fiatCurrency: null,
      fiatAmount: null,
      providerData: input.providerData ?? {},
      serializedTx: input.serializedTx ?? null,
      signature: null,
      slot: null,
      initiatedByKeyId: input.initiatedByKeyId ?? null,
      idempotencyKey,
      idempotencyFingerprint: input.idempotency?.fingerprint ?? null,
    });

    if (!createdRow) {
      throw internalError("Failed to create payment transfer record");
    }

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
  /** The ramp deposit a `transferId` request funds, in the caller's project, whatever its state. */
  rampTransfer: TransferRow | null;
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

async function updateOnchainTransferForRamp(
  c: AppContext,
  input: {
    /** The deposit row authorize loaded in the caller's project. */
    existing: TransferRow;
    scope: ResolvedScope;
    operation: OutboundPaymentOperation;
    destinationAddress: string;
    idempotency: { key: string; fingerprint: string } | null;
  }
): Promise<TransferRow> {
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

  const db = getDb(c.env);
  const updated = await createPostgresPaymentsRepository(
    db,
    getRequestTenantScope(c)
  ).updateOnchainTransferForRamp({
    ...tenant,
    custodyWalletId: operation.sourceWallet.id,
    walletId: operation.sourceWallet.walletId,
    sourceAddress: operation.sourceWallet.publicKey,
    destinationAddress,
    token: operation.token,
    amount: operation.amount,
    initiatedByKeyId: scope.auth.id,
    idempotency: input.idempotency,
    updatedAt: new Date().toISOString(),
  });
  if (!updated) {
    throw conflict("Ramp transfer already has an on-chain transaction");
  }
  return updated;
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
  // Read fresh, never from the cached snapshot, which drops a binding once its
  // wallet is inactive and would refuse the replay of a transfer that ran.
  authorizeCustodyPaymentWallet(c, body.sourceCustodyWalletId, ["payments:write"]);
  const scope = await resolveScope(c, body.sourceCustodyWalletId);
  assertPaymentProjectScope(body.projectId, requireProjectId(c));
  const operation = resolveOutboundPaymentOperation({
    wallets: scope.wallets,
    sourceCustodyWalletId: body.sourceCustodyWalletId,
    destination: body.destination,
    token: body.token,
    amount: body.amount,
  });
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
  return { scope, operation, rampTransfer };
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
    status: TransferStatus;
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
  const now = new Date().toISOString();

  const updated = await repository.updateTransfer({
    transferId: transfer.id,
    organizationId: transfer.organization_id,
    projectId: transfer.project_id,
    expectedStatus: "processing",
    status: patch.status,
    signature: patch.signature,
    serializedTx: patch.serializedTx,
    slot: patch.slot,
    blockTime: patch.blockTime,
    fee: patch.fee,
    error: patch.error,
    providerData:
      patch.failureCode === undefined ? undefined : executionFailureData(patch.failureCode),
    updatedAt: now,
  });

  if (updated) {
    return { outcome: "updated", row: updated };
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
 * A failure after the durable start marker remains processing for chain
 * reconciliation. Before that marker, no broadcast was possible and the
 * transfer can fail normally.
 */
async function settleTransferExecutionFailure(
  c: AppContext,
  transfer: TransferRow,
  recorder: { submittedRow(): Promise<TransferRow | null> },
  error: unknown,
  toPayload: (row: TransferRow) => Record<string, unknown>,
  onConcurrentChainVerdict?: (settled: TransferRow) => Promise<void>
): Promise<Response> {
  const submitted = await recorder.submittedRow();
  if (submitted && !isDefiniteExecutionFailure(error)) {
    logSubmittedUnconfirmed(transfer, submitted.signature, error);
    return success(c, toPayload(submitted));
  }
  const message = error instanceof Error ? error.message : "Unknown transfer error";
  const answer = mapTransferExecutionError(error);
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
    return success(c, toPayload(settled));
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
    buildInstructions: (context: {
      signer: TransactionSigner;
      feePayer: Address;
      rpc: SolanaRpc;
    }) => Promise<readonly Instruction[]>;
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
  const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(rpc, "confirmed");
  const feePayment = createSponsorshipFeePayment(
    c.env,
    resolveRequestSponsorshipScope(c),
    "payments.transfer"
  );
  const feePayer = await feePayment.getFeePayer();
  const instructions = await params.buildInstructions({ signer, feePayer, rpc });

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
    (m) => addSignersToTransactionMessage([signer], m)
  );

  const partiallySigned = await partiallySignTransactionMessageWithSigners(message);
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
    commitment: "confirmed",
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

async function executeSolTransfer(
  c: AppContext,
  sourceWallet: CustodyWallet,
  destinationAddress: Address,
  amount: string,
  submissionStore: SignedSubmissionStore
): Promise<{ signature: string; slot: number | null; blockTime: string | null }> {
  const lamports = parseDecimalAmount(amount, 9);
  if (lamports <= 0n) {
    throw badRequest("Transfer amount must be greater than zero");
  }
  return executeSponsoredTransfer(c, {
    sourceWallet,
    submissionStore,
    buildInstructions: async ({ signer }) => [
      getTransferSolInstruction({
        source: signer,
        destination: destinationAddress,
        amount: lamports,
      }),
    ],
  });
}

async function executeSplTransfer(
  c: AppContext,
  sourceWallet: CustodyWallet,
  destinationAddress: Address,
  mintAddress: Address,
  amount: string,
  submissionStore: SignedSubmissionStore
): Promise<{ signature: string; slot: number | null; blockTime: string | null }> {
  return executeSponsoredTransfer(c, {
    sourceWallet,
    submissionStore,
    buildInstructions: async ({ signer, feePayer, rpc }) => {
      const { createDestinationAtaInstruction, transferInstruction } =
        await buildSplTransferInstructions(rpc, {
          authority: signer,
          destination: destinationAddress,
          mint: mintAddress,
          amount,
          ataRentPayer: feePayer,
        });
      return [createDestinationAtaInstruction, transferInstruction];
    },
  });
}

function buildTransferReplayPayload(replay: TransferRow) {
  return { transfer: mapTransferRow(replay) };
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
function replayTransferRow(c: AppContext, row: TransferRow): Response {
  if (row.status !== "failed") {
    return success(c, buildTransferReplayPayload(row));
  }
  const recorded = row.provider_data[EXECUTION_FAILURE_KEY];
  const recordedCode =
    typeof recorded === "object" && recorded !== null && "code" in recorded
      ? recorded.code
      : undefined;
  // A row the reconciler failed from the chain records no code: it is a
  // transaction failure.
  const code = isErrorCode(recordedCode) ? recordedCode : "TRANSACTION_FAILED";
  // Returned, not thrown: replayFromRecord marks the Response the finder builds.
  return appErrorResponse(
    c,
    new AppError(
      code,
      `${row.error ?? "The transfer failed"}. This Idempotency-Key belongs to a transfer that failed; send the request again with a new Idempotency-Key to try again.`,
      { transferId: row.id, status: row.status }
    )
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

export async function createTransfer(c: ValidatedBodyContext<typeof createTransferSchema>) {
  const body = c.req.valid("json");
  const { scope, operation, rampTransfer } = getAuthorized<TransferResolved>(c);
  // The credential-bound record key (ADR 0009), never the raw client key.
  const recordKey = getIdempotencyRecordKey(c);
  const fingerprint = getIdempotencyFingerprint(c);
  const idempotency =
    recordKey !== undefined && fingerprint !== undefined ? { key: recordKey, fingerprint } : null;

  const reusedRampTransfer = rampTransfer !== null;
  const { row: transfer, replayed } = rampTransfer
    ? {
        row: await updateOnchainTransferForRamp(c, {
          existing: rampTransfer,
          scope,
          operation,
          destinationAddress: body.destination,
          idempotency,
        }),
        replayed: false,
      }
    : await createTransferRecord(c, {
        organizationId: scope.auth.organizationId,
        projectId: requireProjectId(c),
        custodyWalletId: operation.sourceWallet.id,
        walletId: operation.sourceWallet.walletId,
        sourceAddress: operation.sourceWallet.publicKey,
        destinationAddress: body.destination,
        token: operation.token,
        amount: operation.amount,
        memo: body.memo,
        status: "processing",
        initiatedByKeyId: scope.auth.id,
        idempotency,
      });

  if (replayed) {
    return replayTransferRow(c, transfer);
  }
  // The row exists under the key: from here every answer is the request's own,
  // stored for its retries even when it is a 400 or 409.
  markIdempotencyCommitted(c);

  const submissionStore = createTransferSignedSubmissionStore(getPaymentsRepository(c), transfer);
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
      },
    });
  } catch (error) {
    // Nothing was broadcast, but the processing row is already durable and an
    // idempotent retry would replay it as if it had executed. Settle it failed
    // so the ledger refusal cannot mint an unaudited, replayable transfer.
    await updateTransferRecord(c, transfer, {
      status: "failed",
      error: "Audit ledger admission failed before execution",
      failureCode: error instanceof AppError ? error.code : "INTERNAL_ERROR",
    });
    throw error;
  }
  try {
    if (isNativePaymentToken(operation.token)) {
      const solResult = await executeSolTransfer(
        c,
        operation.sourceWallet,
        operation.destinationAddress,
        operation.amount,
        submissionStore
      );
      const updated = resolveTransferUpdateResult(
        await updateTransferRecord(c, transfer, {
          status: reusedRampTransfer ? "settling" : "confirmed",
          signature: solResult.signature,
          slot: solResult.slot,
          blockTime: solResult.blockTime,
          error: null,
        })
      );
      await auditService.completeCritical(c, auditIntent, {
        metadata: { signature: solResult.signature, slot: solResult.slot?.toString() ?? null },
      });
      return success(c, { transfer: mapTransferRow(updated) });
    }

    const mintAddress = assertValidAddress(operation.token, "token");
    const result = await executeSplTransfer(
      c,
      operation.sourceWallet,
      operation.destinationAddress,
      mintAddress,
      operation.amount,
      submissionStore
    );

    const updated = resolveTransferUpdateResult(
      await updateTransferRecord(c, transfer, {
        status: reusedRampTransfer ? "settling" : "confirmed",
        signature: result.signature,
        slot: result.slot,
        blockTime: result.blockTime,
        error: null,
      })
    );
    await auditService.completeCritical(c, auditIntent, {
      metadata: { signature: result.signature, slot: result.slot?.toString() ?? null },
    });

    return success(c, { transfer: mapTransferRow(updated) });
  } catch (error) {
    try {
      return await settleTransferExecutionFailure(
        c,
        transfer,
        submissionStore,
        error,
        (row) => ({ transfer: mapTransferRow(row) }),
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

function assertTransferReadAccess(c: AppContext, row: TransferRow): void {
  assertPaymentWalletReadAccess(c, {
    custodyWalletId: row.custody_wallet_id,
    providerWalletId: row.wallet_id,
  });
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Wallet-scoped transfer listing merges DB rows with observed on-chain history.
export async function listTransfers(c: AppContext) {
  const auth = getAuth(c);
  const query = listTransfersQuerySchema.safeParse(c.req.query());
  if (!query.success) throw badRequestQuery();
  const walletAuthorization = getAllowedApiKeyWalletAuthorizationForPermissions(auth, [
    "payments:read",
  ]);

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
  const transferTypes = requestedTypes ?? categoryTypes;
  if (
    requestedTypes &&
    categoryTypes &&
    requestedTypes.some((type) => !categoryTypes.includes(type as never))
  ) {
    throw badRequest("type must match the requested transfer category");
  }
  const transferTypeSet = transferTypes ? new Set<TransferType>(transferTypes) : undefined;
  // Rows store mints, so a symbol or native-SOL filter must be normalized to
  // the same canonical mint before either the in-memory or SQL comparison.
  const tokenFilter = token ? normalizePaymentToken(token) : undefined;
  const hasProvider = provider !== undefined;
  const hasProviderReference = providerReference !== undefined;
  const hasExactProviderReference = hasProvider && hasProviderReference;

  let exactWallet: CustodyWallet | null = null;
  if (custodyWalletId) {
    if (walletAuthorization && !walletAuthorization.custodyWalletIds.includes(custodyWalletId)) {
      throw forbidden("API key is not authorized for the requested wallet");
    }
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

  if (hasExactProviderReference) {
    const row = await repo.getTransferByProviderReference({
      provider,
      providerReference,
      organizationId: auth.organizationId,
      projectId: requireProjectId(c),
    });

    if (row) assertTransferReadAccess(c, row);
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
    if (
      !custodyWalletId &&
      walletAuthorization !== null &&
      walletAuthorization.custodyWalletIds.length === 0 &&
      walletAuthorization.providerWalletIds.length === 0
    ) {
      return paginated(c, [], { total: 0, page, pageSize });
    }

    const queryStartedAt = performance.now();
    const result = await repo.listTransfers({
      organizationId: auth.organizationId,
      projectId: requireProjectId(c),
      custodyWalletId,
      walletAuthorization:
        custodyWalletId || walletAuthorization === null ? undefined : walletAuthorization,
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
    for (const row of transferRows) assertTransferReadAccess(c, row);
  }

  const transfers = transferRows.map(mapTransferRow);
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

  if (!row) throw notFound("Transfer");
  assertTransferReadAccess(c, row);

  return success(c, { transfer: mapTransferRow(row) });
}
