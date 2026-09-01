import { compareDecimalAmounts } from "@sdp/payments/decimal";
import * as solanaRpc from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { MAX_SAFE_BASE_UNITS, parseDecimalAmount } from "@sdp/solana/amount";
import {
  type Permission,
  type PolicyCandidate,
  type PrivateTransferRequest,
  SUCCESSFUL_PAYMENT_TRANSFER_STATUSES,
} from "@sdp/types";
import type { Address } from "@solana/kit";
import {
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import {
  assertIsTransactionPartialSigner,
  partiallySignTransactionMessageWithSigners,
  partiallySignTransactionWithSigners,
} from "@solana/signers";
import { getTransferSolInstruction } from "@solana-program/system";
import { z } from "zod";
import { getDb } from "@/db";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import {
  generatePaymentTransferId,
  type PaymentsRepository,
  RAMP_TRANSFER_TYPES,
  type PaymentTransferDirection as TransferDirection,
  type PaymentTransferRow as TransferRow,
  type PaymentTransferStatus as TransferStatus,
  type PaymentTransferType as TransferType,
  WALLET_TRANSFER_TYPES,
} from "@/db/repositories/payments.repository";
import { createPostgresPaymentsRepository } from "@/db/repositories/payments.repository.postgres";
import { getAuth } from "@/lib/auth";
import { mapSettledWithConcurrency } from "@/lib/concurrency";
import {
  AppError,
  accountFrozen,
  badRequest,
  badRequestQuery,
  conflict,
  notFound,
  solanaRpcError,
} from "@/lib/errors";
import {
  buildLegacyPaymentTransferFingerprint,
  buildPaymentTransferFingerprint,
  resolveIdentityBoundIdempotencyReplay,
} from "@/lib/idempotency";
import { paginated, success } from "@/lib/response";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import { isDryRunRequest } from "@/middleware/dry-run";
import { enforceMeteredQuota } from "@/middleware/metered-quota";
import { getPolicyGateContext, type PolicyGateExtraction } from "@/middleware/policy-gate";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { getLogger } from "@/runtime/logger";
import { logEvent } from "@/runtime/money-path-events";
import {
  assertApiKeyWalletAccess,
  assertFreshApiKeyCustodyWalletAccess,
  getAllowedApiKeyWalletAuthorizationForPermissions,
} from "@/services/api-key-scope.service";
import {
  assertPaymentProjectScope,
  isNativePaymentToken,
  normalizePaymentToken,
  type OutboundPaymentOperation,
  resolveOutboundPaymentOperation,
} from "@/services/payment-operation.service";
import {
  createTransferSignedSubmissionStore,
  isDefiniteSubmissionError,
  type SignedSubmissionStore,
  submitSignedPaymentTransaction,
} from "@/services/payments/signed-submission";
import {
  approvedWalletOperationId,
  assertApprovedWalletOperationCustodyWallet,
  beginApprovedWalletOperationEffect,
  runApprovedWalletOperationEffectTransaction,
} from "@/services/policy/approved-operation-replay";
import { dryRunPolicyCandidate } from "@/services/policy/candidate-evaluation.service";
import { walletOperationActorFromAuth } from "@/services/policy/enforcement.service";
import {
  type MagicBlockPrivateTransferOptions as MagicBlockProviderTransferOptions,
  type MagicBlockUnsignedTransaction,
  prepareMagicBlockPrivateTransfer,
} from "@/services/private-transfers";
import * as solanaServices from "@/services/solana";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import { type AppContext, getFeePayment, getPaymentsRepository } from "../context";
import { mapTransferRow } from "../mappers";
import {
  type createTransferSchema,
  listTransfersQuerySchema,
  transferIdParamsSchema,
  walletIdParamsSchema,
} from "../schemas";
import * as tokenAccounts from "../token-accounts";
import { resolveMintDecimals, resolveMintTokenProgram } from "../token-accounts";
import {
  admitExactPaymentWallet,
  assertPaymentWalletExactAccess,
  assertPaymentWalletReadAccess,
  type ResolvedScope,
  resolveScope,
  resolveWallet,
  resolveWalletByCustodyWalletId,
} from "../wallets";
import {
  buildObservedTransfersForSignatures,
  createSignatureHistoryRpc,
  dedupeSignatureHistory,
  MAX_TOKEN_ACCOUNT_SIGNATURE_LOOKUPS,
  resolveWalletTokenAccountAddresses,
  SIGNATURE_HISTORY_LOOKUP_CONCURRENCY,
} from "./observed-transfers";

type PreparedPrivateTransferMetadata = {
  provider: "magicblock";
  magicBlock: {
    kind: MagicBlockUnsignedTransaction["kind"];
    version: MagicBlockUnsignedTransaction["version"];
    instructionCount: number;
    requiredSigners: string[];
    validator?: string;
  };
};

export async function resolveWalletFromParams(
  c: AppContext,
  requiredWalletPermissions: Permission[] = []
) {
  const params = walletIdParamsSchema.safeParse(c.req.param());
  if (!params.success) {
    throw badRequest("Invalid wallet ID");
  }

  const scope = await resolveScope(c);
  const wallet = resolveWallet(scope.wallets, params.data.walletId);
  assertApiKeyWalletAccess(scope.auth, wallet.walletId, requiredWalletPermissions);

  return {
    ...scope,
    wallet,
  };
}

async function resolveTransferIdempotencyReplay(
  repository: PaymentsRepository,
  organizationId: string,
  projectId: string | null,
  idempotencyKey: string,
  fingerprint: string,
  legacyFingerprint: string,
  custodyWalletId: string
): Promise<TransferRow | null> {
  return resolveIdentityBoundIdempotencyReplay(
    () => repository.findTransferByIdempotency({ organizationId, projectId, idempotencyKey }),
    fingerprint,
    legacyFingerprint,
    (row) => row.custody_wallet_id === custodyWalletId
  );
}

async function createTransferRecord(
  c: AppContext,
  input: {
    organizationId: string;
    projectId: string | null;
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
    idempotencyKey?: string | null;
    privateTransfer?: unknown;
    providerData?: Record<string, unknown>;
  }
): Promise<{ row: TransferRow; replayed: boolean }> {
  const idempotencyKey = input.idempotencyKey ?? null;
  const fingerprintInput = {
    custodyWalletId: input.custodyWalletId,
    sourceAddress: input.sourceAddress,
    destinationAddress: input.destinationAddress,
    token: input.token,
    amount: input.amount,
    memo: input.memo,
    type: input.type ?? "transfer",
    privateTransfer: input.privateTransfer,
  };
  const idempotencyFingerprint = idempotencyKey
    ? buildPaymentTransferFingerprint(fingerprintInput)
    : null;
  const legacyIdempotencyFingerprint = idempotencyKey
    ? buildLegacyPaymentTransferFingerprint(fingerprintInput)
    : null;

  try {
    return await runApprovedWalletOperationEffectTransaction(c, async (db) => {
      const repository = createPostgresPaymentsRepository(db, getRequestTenantScope(c));

      if (idempotencyKey && idempotencyFingerprint && legacyIdempotencyFingerprint) {
        const existing = await resolveTransferIdempotencyReplay(
          repository,
          input.organizationId,
          input.projectId,
          idempotencyKey,
          idempotencyFingerprint,
          legacyIdempotencyFingerprint,
          input.custodyWalletId
        );
        if (existing) {
          return { row: existing, replayed: true };
        }
      }

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
        // HOO-1023: persist the K2 shape until rollback support ends.
        idempotencyFingerprint: legacyIdempotencyFingerprint,
      });

      if (!createdRow) {
        throw new AppError("INTERNAL_ERROR", "Failed to create payment transfer record");
      }

      return { row: createdRow, replayed: false };
    });
  } catch (error) {
    if (
      idempotencyKey &&
      idempotencyFingerprint &&
      legacyIdempotencyFingerprint &&
      isPostgresUniqueViolation(error)
    ) {
      const existing = await resolveTransferIdempotencyReplay(
        getPaymentsRepository(c),
        input.organizationId,
        input.projectId,
        idempotencyKey,
        idempotencyFingerprint,
        legacyIdempotencyFingerprint,
        input.custodyWalletId
      );
      if (existing) {
        return { row: existing, replayed: true };
      }
    }
    throw error;
  }
}

async function assertApprovedTransferReplayCompleted(c: AppContext, transfer: TransferRow) {
  if (!approvedWalletOperationId(c)) {
    return;
  }

  const completed =
    transfer.signature !== null &&
    SUCCESSFUL_PAYMENT_TRANSFER_STATUSES.some((status) => status === transfer.status);
  if (completed) {
    await assertApprovedWalletOperationCustodyWallet(c, transfer.custody_wallet_id);
    return;
  }

  // This can only be legacy state created by the pre-atomic implementation or
  // external database damage. Fence it before failing so recovery never turns
  // the incomplete idempotency replay into a successful approved operation.
  await beginApprovedWalletOperationEffect(c);
  throw new AppError(
    "CONFLICT",
    "Approved transfer execution is incomplete and requires manual reconciliation"
  );
}

/**
 * Build the policy candidate for a transfer operation from its resolved scope
 * and outbound operation — the single source for both the gated primary leg
 * and the in-flow signer legs.
 *
 * @param scope - The resolved request scope.
 * @param operation - The resolved outbound payment operation.
 * @param input - The transfer memo and private-transfer flag.
 * @returns The policy candidate for the operation.
 */
function buildTransferPolicyCandidate(
  scope: ResolvedScope,
  operation: OutboundPaymentOperation,
  input: { memo: string | null; privateTransfer: boolean }
): PolicyCandidate {
  return {
    organizationId: scope.auth.organizationId,
    projectId: scope.auth.projectId,
    custodyWalletId: operation.sourceWallet.id,
    walletId: operation.sourceWallet.walletId,
    apiKeyId: scope.auth.apiKeyId,
    actor: walletOperationActorFromAuth(scope.auth),
    source: "api",
    operationFamily: "payment",
    operationType: "payment_transfer_execute",
    asset: operation.token,
    amount: operation.amount,
    destination: operation.destinationAddress,
    context: {
      sourceAddress: operation.sourceAddress,
      memo: input.memo,
      privateTransfer: input.privateTransfer,
    },
    providerExtensions: {},
  };
}

type CreateTransferBody = z.output<typeof createTransferSchema>;

interface TransferPolicyResolved {
  scope: ResolvedScope;
  operation: OutboundPaymentOperation;
  privateTransfer: PrivateTransferRequest | undefined;
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
    transferId: string;
    scope: ResolvedScope;
    operation: OutboundPaymentOperation;
    destinationAddress: string;
  }
): Promise<TransferRow> {
  const { transferId, scope, operation, destinationAddress } = input;
  const tenant = {
    transferId,
    organizationId: scope.auth.organizationId,
    projectId: scope.auth.projectId,
  };
  const existing = await getPaymentsRepository(c).getTransferById(tenant);
  if (!existing) throw notFound("Ramp transfer");

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
  if (existing.status !== "awaiting_payment" || rampTransferHasOnchainValues(existing)) {
    throw conflict("Ramp transfer already has an on-chain transaction");
  }

  const updated = await runApprovedWalletOperationEffectTransaction(c, async (db) =>
    createPostgresPaymentsRepository(db, getRequestTenantScope(c)).updateOnchainTransferForRamp({
      ...tenant,
      custodyWalletId: operation.sourceWallet.id,
      walletId: operation.sourceWallet.walletId,
      sourceAddress: operation.sourceWallet.publicKey,
      destinationAddress,
      token: operation.token,
      amount: operation.amount,
      initiatedByKeyId: scope.auth.id,
      updatedAt: new Date().toISOString(),
    })
  );
  if (!updated) {
    throw conflict("Ramp transfer already has an on-chain transaction");
  }
  return updated;
}

/**
 * Parse and resolve a create-transfer request into its policy candidate for
 * the policy gate: validated body, resolved scope and outbound operation, and
 * the enforcement raw payload.
 *
 * @param c - Request context.
 * @returns The candidate, validated body, resolved resources, and raw payload.
 */
export async function extractTransferPolicyCandidate(
  c: ValidatedBodyContext<typeof createTransferSchema>
): Promise<PolicyGateExtraction> {
  const body = c.req.valid("json");
  assertPaymentWalletExactAccess(c, body.sourceCustodyWalletId, ["payments:write"]);

  const scope = await resolveScope(
    c,
    c.req.header("Idempotency-Key") !== undefined && !isDryRunRequest(c)
      ? body.sourceCustodyWalletId
      : undefined
  );
  assertPaymentProjectScope(body.projectId, scope.auth.projectId);
  const operation = resolveOutboundPaymentOperation({
    auth: scope.auth,
    wallets: scope.wallets,
    sourceCustodyWalletId: body.sourceCustodyWalletId,
    destination: body.destination,
    token: body.token,
    amount: body.amount,
    env: c.env,
    requiredWalletPermissions: ["payments:write"],
  });
  const privateTransfer = body.privateTransfer as PrivateTransferRequest | undefined;
  const { sourceCustodyWalletId: _sourceCustodyWalletId, ...legacyBody } = body;

  return {
    candidate: buildTransferPolicyCandidate(scope, operation, {
      memo: body.memo === undefined ? null : body.memo,
      privateTransfer: Boolean(privateTransfer),
    }),
    legs: [],
    body,
    resolved: { scope, operation, privateTransfer },
    // HOO-1023: remove this legacy envelope when K2 rollback support ends.
    executionRequestBody: { ...legacyBody, source: operation.sourceWallet.walletId },
    rawPayload: {
      source: operation.sourceWallet.walletId,
      destination: body.destination,
      token: body.token,
      amount: body.amount,
    },
    idempotencyKey: null,
  };
}

export async function admitTransferRuntimeExecution(
  c: AppContext,
  extraction: PolicyGateExtraction
): Promise<void> {
  // SAFETY: this callback is wired only beside extractTransferPolicyCandidate in payments/index.ts.
  const { operation } = extraction.resolved as TransferPolicyResolved;
  await admitExactPaymentWallet(c, operation.sourceWallet, ["payments:write"]);
}

/**
 * Resolve an Idempotency-Key replay for a create-transfer request: a key that
 * matches a recorded transfer with the same fingerprint returns the recorded
 * outcome, so the gate never re-enforces a replayed intent.
 *
 * @param c - Request context.
 * @param extraction - The extraction produced by extractTransferPolicyCandidate.
 * @param idempotencyKey - The Idempotency-Key header value the gate read.
 * @returns The recorded response, or null when the request is a new intent.
 */
export async function findTransferIdempotentKeyReplay(
  c: AppContext,
  extraction: PolicyGateExtraction,
  idempotencyKey: string
): Promise<Response | null> {
  const body = extraction.body as CreateTransferBody;
  if (body.transferId) return null;
  const { scope, operation, privateTransfer } = extraction.resolved as TransferPolicyResolved;

  const fingerprintInput = {
    custodyWalletId: operation.sourceWallet.id,
    sourceAddress: operation.sourceWallet.publicKey,
    destinationAddress: body.destination,
    token: operation.token,
    amount: operation.amount,
    memo: body.memo,
    type: privateTransfer ? "transfer_confidential" : "transfer",
    privateTransfer,
  };
  const replay = await resolveTransferIdempotencyReplay(
    getPaymentsRepository(c),
    scope.auth.organizationId,
    scope.auth.projectId,
    idempotencyKey,
    buildPaymentTransferFingerprint(fingerprintInput),
    buildLegacyPaymentTransferFingerprint(fingerprintInput),
    operation.sourceWallet.id
  );
  if (!replay) {
    return null;
  }

  await assertApprovedTransferReplayCompleted(c, replay);
  return success(c, buildTransferReplayPayload(replay));
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
  }
): Promise<TransferRow> {
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
    updatedAt: now,
  });

  if (updated) {
    return updated;
  }

  const current = await repository.getTransferById({
    transferId: transfer.id,
    organizationId: transfer.organization_id,
    projectId: transfer.project_id,
  });
  if (!current) {
    throw new AppError("INTERNAL_ERROR", "Payment transfer record not found for update");
  }

  return current;
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
  toPayload: (row: TransferRow) => Record<string, unknown>
): Promise<Response> {
  const submitted = await recorder.submittedRow();
  if (submitted && !isDefiniteExecutionFailure(error)) {
    logSubmittedUnconfirmed(transfer, submitted.signature, error);
    return success(c, toPayload(submitted));
  }
  const message = error instanceof Error ? error.message : "Unknown transfer error";
  const settled = await updateTransferRecord(c, transfer, {
    status: "failed",
    error: message,
    signature: submitted?.signature,
    blockTime: null,
  });
  if (settled.status !== "failed") {
    return success(c, toPayload(settled));
  }
  throw mapTransferExecutionError(error);
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

  const auth = getAuth(c);
  const signer = await solanaServices.createOrgSignerForCustodyWallet(
    c.env,
    auth.organizationId,
    auth.projectId ?? undefined,
    sourceWallet.id
  );

  if (signer.address !== sourceWallet.publicKey) {
    throw badRequest("Resolved signing wallet does not match source wallet");
  }

  const rpc = solanaRpc.createRpc(c.env);
  const { blockhash, lastValidBlockHeight } = await solanaRpc.getRecentBlockhash(rpc, "confirmed");
  const feePayment = getFeePayment(c);
  const feePayer = await feePayment.getFeePayer();

  const instruction = getTransferSolInstruction({
    source: signer,
    destination: destinationAddress,
    amount: lamports,
  });

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions([instruction], m),
    (m) => addSignersToTransactionMessage([signer], m)
  );

  const partiallySigned = await partiallySignTransactionMessageWithSigners(message);
  const txEncoder = getTransactionEncoder();
  const txBytes = new Uint8Array(txEncoder.encode(partiallySigned));
  await beginApprovedWalletOperationEffect(c);
  const signature = await submitSignedPaymentTransaction({
    feePayment,
    rpc,
    transaction: txBytes,
    lastValidBlockHeight,
    store: submissionStore,
  });

  const confirmation = await solanaRpc.confirmTransaction(rpc, signature, {
    commitment: "confirmed",
  });

  if (confirmation.err) {
    throw new AppError("TRANSACTION_FAILED", "SOL transfer failed on-chain");
  }

  return {
    signature,
    slot: Number(confirmation.slot),
    blockTime: null,
  };
}

type MagicBlockProductOptions = Extract<
  PrivateTransferRequest,
  { provider: "magicblock" }
>["magicBlock"];

function buildMagicBlockProviderTransferOptions(
  options: MagicBlockProductOptions,
  context?: { koraSponsoredExecution?: boolean }
): MagicBlockProviderTransferOptions {
  const gasless = context?.koraSponsoredExecution ? true : options.gasless;

  return {
    ...(options.validator ? { validator: options.validator } : {}),
    ...(options.initIfMissing !== undefined ? { initIfMissing: options.initIfMissing } : {}),
    ...(options.initAtasIfMissing !== undefined
      ? { initAtasIfMissing: options.initAtasIfMissing }
      : {}),
    ...(options.initVaultIfMissing !== undefined
      ? { initVaultIfMissing: options.initVaultIfMissing }
      : {}),
    ...(options.minDelayMs !== undefined ? { minDelayMs: options.minDelayMs } : {}),
    ...(options.maxDelayMs !== undefined ? { maxDelayMs: options.maxDelayMs } : {}),
    ...(options.clientRefId !== undefined ? { clientRefId: options.clientRefId } : {}),
    ...(options.split !== undefined ? { split: options.split } : {}),
    ...(gasless !== undefined ? { gasless } : {}),
    ...(options.legacy !== undefined ? { legacy: options.legacy } : {}),
  };
}

function mapMagicBlockPreparedTransfer(
  unsignedTransaction: MagicBlockUnsignedTransaction,
  trustedLastValidBlockHeight: bigint
): {
  prepared: {
    serializedTx: string;
    blockhash: string;
    lastValidBlockHeight: string;
  };
  metadata: PreparedPrivateTransferMetadata;
} {
  const providerLastValidBlockHeight = BigInt(unsignedTransaction.lastValidBlockHeight);
  return {
    prepared: {
      serializedTx: unsignedTransaction.transactionBase64,
      blockhash: unsignedTransaction.recentBlockhash,
      lastValidBlockHeight: (providerLastValidBlockHeight < trustedLastValidBlockHeight
        ? providerLastValidBlockHeight
        : trustedLastValidBlockHeight
      ).toString(),
    },
    metadata: {
      provider: "magicblock",
      magicBlock: {
        kind: unsignedTransaction.kind,
        version: unsignedTransaction.version,
        instructionCount: unsignedTransaction.instructionCount,
        requiredSigners: unsignedTransaction.requiredSigners,
        ...(unsignedTransaction.validator ? { validator: unsignedTransaction.validator } : {}),
      },
    },
  };
}

async function prepareMagicBlockPrivateTransferForOperation(params: {
  c: AppContext;
  operation: OutboundPaymentOperation;
  privateTransfer: PrivateTransferRequest;
  memo?: string;
  koraSponsoredExecution?: boolean;
}) {
  const { c, operation, privateTransfer, memo } = params;

  if (isNativePaymentToken(operation.token)) {
    throw new AppError(
      "BAD_REQUEST",
      "MagicBlock private transfers support SPL tokens only. Provide a token mint address."
    );
  }

  const mintAddress = assertValidAddress(operation.token, "token");
  const rpc = solanaRpc.createRpc(c.env);
  await resolveMintTokenProgram(rpc, mintAddress);
  const decimals = await resolveMintDecimals(rpc, mintAddress);
  const amountBaseUnits = parseDecimalAmount(operation.amount, decimals);

  if (amountBaseUnits <= 0n) {
    throw badRequest("Transfer amount must be greater than zero");
  }

  if (amountBaseUnits > MAX_SAFE_BASE_UNITS) {
    throw new AppError(
      "BAD_REQUEST",
      "MagicBlock transfer amount is too large to send as a JSON integer."
    );
  }

  const [magicBlockPrepared, { lastValidBlockHeight }] = await Promise.all([
    prepareMagicBlockPrivateTransfer(c.env, {
      from: operation.sourceAddress,
      to: operation.destinationAddress,
      mint: mintAddress,
      amount: Number(amountBaseUnits),
      memo,
      options: buildMagicBlockProviderTransferOptions(privateTransfer.magicBlock, {
        koraSponsoredExecution: params.koraSponsoredExecution,
      }),
    }),
    solanaRpc.getRecentBlockhash(rpc, "confirmed"),
  ]);

  return mapMagicBlockPreparedTransfer(magicBlockPrepared, lastValidBlockHeight);
}

function assertMagicBlockKoraSponsoredExecutionOptions(options: MagicBlockProductOptions): void {
  if (options.gasless === false) {
    throw new AppError(
      "BAD_REQUEST",
      "MagicBlock private transfer execution is sponsored by Kora and requires gasless transactions. Remove gasless or set it to true."
    );
  }
}

function decodeMagicBlockPreparedTransaction(serializedTx: string) {
  const txBytes = Buffer.from(serializedTx, "base64");
  const transaction = getTransactionDecoder().decode(txBytes);
  const compiledMessage = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);

  if (!("instructions" in compiledMessage) || !("staticAccounts" in compiledMessage)) {
    throw new AppError(
      "PROVIDER_UNAVAILABLE",
      "MagicBlock transaction version is not supported for Kora fee sponsorship."
    );
  }

  const existingFeePayer = compiledMessage.staticAccounts[0];

  if (!existingFeePayer) {
    throw new AppError("PROVIDER_UNAVAILABLE", "MagicBlock transaction has no fee payer.");
  }

  return { transaction, compiledMessage, existingFeePayer };
}

type DecodedMagicBlockPreparedTransaction = ReturnType<typeof decodeMagicBlockPreparedTransaction>;

function addSponsoredFeePayerToPreparedTransaction(
  decoded: DecodedMagicBlockPreparedTransaction,
  feePayer: Address,
  requiredSigners: string[],
  options?: { replaceExistingFeePayer?: boolean }
) {
  const { transaction, compiledMessage, existingFeePayer } = decoded;

  if (existingFeePayer === feePayer) {
    return transaction;
  }

  if (compiledMessage.staticAccounts.includes(feePayer)) {
    throw new AppError(
      "PROVIDER_UNAVAILABLE",
      "MagicBlock transaction already includes the Kora fee payer in a non-fee-payer position."
    );
  }

  if (options?.replaceExistingFeePayer) {
    const { [existingFeePayer]: _existingFeePayerSignature, ...remainingSignatures } =
      transaction.signatures;
    const sponsoredMessage = {
      ...compiledMessage,
      staticAccounts: [feePayer, ...compiledMessage.staticAccounts.slice(1)],
    };

    const messageBytes = getCompiledTransactionMessageEncoder().encode(
      sponsoredMessage
    ) as typeof transaction.messageBytes;
    const signatures = {
      [feePayer]: null,
      ...remainingSignatures,
    } as typeof transaction.signatures;

    return {
      messageBytes,
      signatures: {
        ...signatures,
      },
    };
  }

  const signerCount = compiledMessage.header.numSignerAccounts;
  const existingFeePayerMustSign = requiredSigners.includes(existingFeePayer);

  if (existingFeePayerMustSign) {
    const remapAccountIndex = (accountIndex: number) => accountIndex + 1;
    const sponsoredMessage = {
      ...compiledMessage,
      header: {
        ...compiledMessage.header,
        numSignerAccounts: signerCount + 1,
      },
      staticAccounts: [feePayer, ...compiledMessage.staticAccounts],
      instructions: compiledMessage.instructions.map((instruction) => ({
        ...instruction,
        programAddressIndex: remapAccountIndex(instruction.programAddressIndex),
        accountIndices: instruction.accountIndices?.map(remapAccountIndex) ?? [],
      })),
    };

    const messageBytes = getCompiledTransactionMessageEncoder().encode(
      sponsoredMessage
    ) as typeof transaction.messageBytes;
    const signatures = {
      [feePayer]: null,
      ...transaction.signatures,
    } as typeof transaction.signatures;

    return {
      messageBytes,
      signatures: {
        ...signatures,
      },
    };
  }

  const remapAccountIndex = (accountIndex: number) => {
    if (accountIndex === 0) {
      return signerCount;
    }

    if (accountIndex < signerCount) {
      return accountIndex;
    }

    return accountIndex + 1;
  };
  const { [existingFeePayer]: _existingFeePayerSignature, ...remainingSignatures } =
    transaction.signatures;
  const sponsoredMessage = {
    ...compiledMessage,
    staticAccounts: [
      feePayer,
      ...compiledMessage.staticAccounts.slice(1, signerCount),
      existingFeePayer,
      ...compiledMessage.staticAccounts.slice(signerCount),
    ],
    instructions: compiledMessage.instructions.map((instruction) => ({
      ...instruction,
      programAddressIndex: remapAccountIndex(instruction.programAddressIndex),
      accountIndices: instruction.accountIndices?.map(remapAccountIndex) ?? [],
    })),
  };

  const messageBytes = getCompiledTransactionMessageEncoder().encode(
    sponsoredMessage
  ) as typeof transaction.messageBytes;
  const signatures = {
    [feePayer]: null,
    ...remainingSignatures,
  } as typeof transaction.signatures;

  return {
    messageBytes,
    signatures: {
      ...signatures,
    },
  };
}

interface PreparedPrivateTransferSignerPlan {
  decodedTransaction: ReturnType<typeof decodeMagicBlockPreparedTransaction>;
  custodyRequiredSigners: string[];
  signerWallets: CustodyWallet[];
  shouldReplaceProviderFeePayer: boolean;
}

async function resolvePreparedPrivateTransferSignerPlan(
  c: AppContext,
  scope: ResolvedScope,
  operation: OutboundPaymentOperation,
  serializedTx: string,
  metadata: PreparedPrivateTransferMetadata
): Promise<PreparedPrivateTransferSignerPlan> {
  const decodedTransaction = decodeMagicBlockPreparedTransaction(serializedTx);
  const requiredSigners = [
    ...new Set(
      decodedTransaction.compiledMessage.staticAccounts
        .slice(0, decodedTransaction.compiledMessage.header.numSignerAccounts)
        .map(String)
    ),
  ];
  const metadataRequiredSigners = new Set(metadata.magicBlock.requiredSigners);
  const decodedSignerFingerprint = JSON.stringify([...requiredSigners].sort());
  const metadataSignerFingerprint = JSON.stringify([...metadataRequiredSigners].sort());
  if (metadataSignerFingerprint !== decodedSignerFingerprint) {
    throw new AppError(
      "PROVIDER_UNAVAILABLE",
      "MagicBlock signer metadata does not match the prepared transaction."
    );
  }
  const existingFeePayer = decodedTransaction.existingFeePayer;
  const shouldReplaceProviderFeePayer =
    requiredSigners.includes(existingFeePayer) &&
    !scope.wallets.some((wallet) => wallet.publicKey === existingFeePayer);
  const custodyRequiredSigners = shouldReplaceProviderFeePayer
    ? requiredSigners.filter((signer) => signer !== existingFeePayer)
    : requiredSigners;
  if (!custodyRequiredSigners.includes(operation.sourceWallet.publicKey)) {
    throw new AppError(
      "PROVIDER_UNAVAILABLE",
      "MagicBlock prepared transaction does not require the selected source wallet."
    );
  }
  const signerWallets = new Map<string, CustodyWallet>();

  for (const requiredSigner of custodyRequiredSigners) {
    if (requiredSigner === operation.sourceWallet.publicKey) {
      signerWallets.set(operation.sourceWallet.id, operation.sourceWallet);
      continue;
    }

    const addressMatches = scope.wallets.filter((wallet) => wallet.publicKey === requiredSigner);
    if (addressMatches.length === 0) {
      throw new AppError(
        "BAD_REQUEST",
        "MagicBlock private transfer requires signer(s) that are not controlled by SDP."
      );
    }

    const authorizedMatches: CustodyWallet[] = [];
    for (const wallet of addressMatches) {
      try {
        await assertFreshApiKeyCustodyWalletAccess(getDb(c.env), scope.auth, wallet.id, [
          "payments:write",
        ]);
        authorizedMatches.push(wallet);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "FORBIDDEN") throw error;
      }
    }

    if (authorizedMatches.length === 0) {
      throw new AppError("FORBIDDEN", "API key is not authorized for the requested wallet");
    }
    if (authorizedMatches.length > 1) {
      throw new AppError("CONFLICT", "MagicBlock additional signer is ambiguous");
    }

    const wallet = authorizedMatches[0];
    if (!wallet) throw new AppError("INTERNAL_ERROR", "MagicBlock signer resolution failed");
    await admitExactPaymentWallet(c, wallet, ["payments:write"]);

    const signerOperation: OutboundPaymentOperation = {
      ...operation,
      sourceAddress: assertValidAddress(wallet.publicKey, "required signer"),
      sourceWallet: wallet,
    };
    const evaluation = await dryRunPolicyCandidate(
      c.env,
      getRequestTenantScope(c),
      buildTransferPolicyCandidate(scope, signerOperation, {
        memo: null,
        privateTransfer: true,
      }),
      []
    );
    const details = { decision: evaluation.decision, reason: evaluation.reason };
    if (evaluation.decision === "deny" || evaluation.decision === "not_evaluated") {
      throw new AppError("FORBIDDEN", "Wallet operation denied by policy", details);
    }
    if (evaluation.decision !== "allow") {
      throw new AppError(
        "CONFLICT",
        "MagicBlock additional signer requires policy approval, but multi-wallet approval replay is not supported",
        details
      );
    }

    signerWallets.set(wallet.id, wallet);
  }

  return {
    decodedTransaction,
    custodyRequiredSigners,
    signerWallets: [...signerWallets.values()],
    shouldReplaceProviderFeePayer,
  };
}

async function executePreparedPrivateTransfer(
  c: AppContext,
  scope: ResolvedScope,
  lastValidBlockHeight: bigint,
  signerPlan: PreparedPrivateTransferSignerPlan,
  submissionStore: SignedSubmissionStore
): Promise<{ signature: string; slot: number | null; blockTime: string | null }> {
  const signers = await Promise.all(
    signerPlan.signerWallets.map(async (wallet) => {
      const signer = await solanaServices.createOrgSignerForCustodyWallet(
        c.env,
        scope.auth.organizationId,
        scope.auth.projectId ?? undefined,
        wallet.id
      );

      if (signer.address !== wallet.publicKey) {
        throw badRequest("Resolved signing wallet does not match required signer");
      }
      assertIsTransactionPartialSigner(signer);
      return signer;
    })
  );

  const feePayment = getFeePayment(c);
  const feePayer = await feePayment.getFeePayer();
  const transaction = addSponsoredFeePayerToPreparedTransaction(
    signerPlan.decodedTransaction,
    feePayer,
    signerPlan.custodyRequiredSigners,
    { replaceExistingFeePayer: signerPlan.shouldReplaceProviderFeePayer }
  );
  const signedTransaction =
    signers.length > 0
      ? await partiallySignTransactionWithSigners(signers, transaction)
      : transaction;
  const encodedSignedTransaction = new Uint8Array(
    getTransactionEncoder().encode(signedTransaction)
  );

  await beginApprovedWalletOperationEffect(c);
  const rpc = solanaRpc.createRpc(c.env);
  const signature = await submitSignedPaymentTransaction({
    feePayment,
    rpc,
    transaction: encodedSignedTransaction,
    lastValidBlockHeight,
    store: submissionStore,
  });
  const confirmation = await solanaRpc.confirmTransaction(rpc, signature, {
    commitment: "confirmed",
  });

  if (confirmation.err) {
    throw new AppError("TRANSACTION_FAILED", "MagicBlock private transfer failed on-chain");
  }

  return {
    signature,
    slot: Number(confirmation.slot),
    blockTime: null,
  };
}

async function executeSplTransfer(
  c: AppContext,
  sourceWallet: CustodyWallet,
  destinationAddress: Address,
  mintAddress: Address,
  amount: string,
  submissionStore: SignedSubmissionStore
): Promise<{ signature: string; slot: number | null; blockTime: string | null }> {
  const auth = getAuth(c);
  const signer = await solanaServices.createOrgSignerForCustodyWallet(
    c.env,
    auth.organizationId,
    auth.projectId ?? undefined,
    sourceWallet.id
  );

  if (signer.address !== sourceWallet.publicKey) {
    throw badRequest("Resolved signing wallet does not match source wallet");
  }

  const rpc = solanaRpc.createRpc(c.env);
  const { blockhash, lastValidBlockHeight } = await solanaRpc.getRecentBlockhash(rpc, "confirmed");
  const feePayment = getFeePayment(c);
  const feePayer = await feePayment.getFeePayer();

  const { createDestinationAtaInstruction, transferInstruction } =
    await tokenAccounts.buildSplTransferInstructions(rpc, {
      authority: signer,
      destination: destinationAddress,
      mint: mintAddress,
      amount,
      ataRentPayer: feePayer,
    });

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) =>
      appendTransactionMessageInstructions(
        [createDestinationAtaInstruction, transferInstruction],
        m
      ),
    (m) => addSignersToTransactionMessage([signer], m)
  );

  const partiallySigned = await partiallySignTransactionMessageWithSigners(message);
  const txEncoder = getTransactionEncoder();
  const txBytes = new Uint8Array(txEncoder.encode(partiallySigned));
  await beginApprovedWalletOperationEffect(c);
  const signature = await submitSignedPaymentTransaction({
    feePayment,
    rpc,
    transaction: txBytes,
    lastValidBlockHeight,
    store: submissionStore,
  });

  const confirmation = await solanaRpc.confirmTransaction(rpc, signature, {
    commitment: "confirmed",
  });

  if (confirmation.err) {
    throw new AppError("TRANSACTION_FAILED", "SPL token transfer failed on-chain");
  }

  return {
    signature,
    slot: Number(confirmation.slot),
    blockTime: null,
  };
}

function buildTransferReplayPayload(replay: TransferRow) {
  const storedPrivateTransfer = (replay.provider_data as Record<string, unknown> | null | undefined)
    ?.privateTransfer;
  return storedPrivateTransfer
    ? { transfer: mapTransferRow(replay), privateTransfer: storedPrivateTransfer }
    : { transfer: mapTransferRow(replay) };
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

export async function createTransfer(c: AppContext) {
  const {
    body,
    resolved: { scope, operation, privateTransfer },
  } = getPolicyGateContext<CreateTransferBody, TransferPolicyResolved>(c);
  const idempotencyKey = c.req.header("Idempotency-Key") ?? null;

  if (privateTransfer) {
    if (body.transferId) {
      throw badRequest("Private transfers cannot reuse a ramp transfer");
    }
    assertMagicBlockKoraSponsoredExecutionOptions(privateTransfer.magicBlock);
    const mapped = await prepareMagicBlockPrivateTransferForOperation({
      c,
      operation,
      privateTransfer,
      memo: body.memo,
      // MagicBlock's gasless response separates the source signer from the provider sponsor.
      // SDP swaps that sponsor slot for Kora before signing and submission.
      koraSponsoredExecution: true,
    });
    const transferType: TransferType = "transfer_confidential";
    const signerPlan = await resolvePreparedPrivateTransferSignerPlan(
      c,
      scope,
      operation,
      mapped.prepared.serializedTx,
      mapped.metadata
    );
    const { row: transfer, replayed } = await createTransferRecord(c, {
      organizationId: scope.auth.organizationId,
      projectId: scope.auth.projectId,
      custodyWalletId: operation.sourceWallet.id,
      walletId: operation.sourceWallet.walletId,
      sourceAddress: operation.sourceWallet.publicKey,
      destinationAddress: body.destination,
      token: operation.token,
      amount: operation.amount,
      memo: body.memo,
      type: transferType,
      status: "processing",
      serializedTx: mapped.prepared.serializedTx,
      initiatedByKeyId: scope.auth.id,
      idempotencyKey,
      privateTransfer,
      providerData: { privateTransfer: mapped.metadata },
    });

    if (replayed) {
      await assertApprovedTransferReplayCompleted(c, transfer);
      return success(c, buildTransferReplayPayload(transfer));
    }

    const submissionStore = createTransferSignedSubmissionStore(getPaymentsRepository(c), transfer);
    try {
      const result = await executePreparedPrivateTransfer(
        c,
        scope,
        BigInt(mapped.prepared.lastValidBlockHeight),
        signerPlan,
        submissionStore
      );
      const updated = await updateTransferRecord(c, transfer, {
        status: "confirmed",
        signature: result.signature,
        slot: result.slot,
        blockTime: result.blockTime,
        error: null,
      });

      return success(c, {
        transfer: mapTransferRow(updated),
        privateTransfer: mapped.metadata,
      });
    } catch (error) {
      return settleTransferExecutionFailure(c, transfer, submissionStore, error, (row) => ({
        transfer: mapTransferRow(row),
        privateTransfer: mapped.metadata,
      }));
    }
  }

  const reusedRampTransfer = body.transferId !== undefined;
  const { row: transfer, replayed } = body.transferId
    ? {
        row: await updateOnchainTransferForRamp(c, {
          transferId: body.transferId,
          scope,
          operation,
          destinationAddress: body.destination,
        }),
        replayed: false,
      }
    : await createTransferRecord(c, {
        organizationId: scope.auth.organizationId,
        projectId: scope.auth.projectId,
        custodyWalletId: operation.sourceWallet.id,
        walletId: operation.sourceWallet.walletId,
        sourceAddress: operation.sourceWallet.publicKey,
        destinationAddress: body.destination,
        token: operation.token,
        amount: operation.amount,
        memo: body.memo,
        status: "processing",
        initiatedByKeyId: scope.auth.id,
        idempotencyKey,
      });

  if (replayed) {
    await assertApprovedTransferReplayCompleted(c, transfer);
    return success(c, buildTransferReplayPayload(transfer));
  }

  const submissionStore = createTransferSignedSubmissionStore(getPaymentsRepository(c), transfer);
  try {
    if (isNativePaymentToken(operation.token)) {
      const solResult = await executeSolTransfer(
        c,
        operation.sourceWallet,
        operation.destinationAddress,
        operation.amount,
        submissionStore
      );
      const updated = await updateTransferRecord(c, transfer, {
        status: reusedRampTransfer ? "settling" : "confirmed",
        signature: solResult.signature,
        slot: solResult.slot,
        blockTime: solResult.blockTime,
        error: null,
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

    const updated = await updateTransferRecord(c, transfer, {
      status: reusedRampTransfer ? "settling" : "confirmed",
      signature: result.signature,
      slot: result.slot,
      blockTime: result.blockTime,
      error: null,
    });

    return success(c, { transfer: mapTransferRow(updated) });
  } catch (error) {
    return settleTransferExecutionFailure(c, transfer, submissionStore, error, (row) => ({
      transfer: mapTransferRow(row),
    }));
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
    throw new AppError("BAD_REQUEST", "type must match the requested transfer category");
  }
  const transferTypeSet = transferTypes ? new Set<TransferType>(transferTypes) : undefined;
  // Rows store mints, so a symbol or native-SOL filter must be normalized to
  // the same canonical mint before either the in-memory or SQL comparison.
  const tokenFilter = token ? normalizePaymentToken(token, c.env) : undefined;
  const hasProvider = provider !== undefined;
  const hasProviderReference = providerReference !== undefined;
  const hasExactProviderReference = hasProvider && hasProviderReference;

  let exactWallet: CustodyWallet | null = null;
  if (custodyWalletId) {
    if (walletAuthorization && !walletAuthorization.custodyWalletIds.includes(custodyWalletId)) {
      throw new AppError("FORBIDDEN", "API key is not authorized for the requested wallet");
    }
    if (includeObserved) {
      const scope = await resolveScope(c);
      exactWallet = resolveWalletByCustodyWalletId(scope.wallets, custodyWalletId);
    }
  }

  if (includeObserved && !exactWallet) {
    throw new AppError("BAD_REQUEST", "custodyWalletId is required when includeObserved=true");
  }

  if (hasProviderReference && !hasProvider) {
    throw new AppError("BAD_REQUEST", "provider is required for provider reference lookup");
  }

  if (hasExactProviderReference) {
    const row = await repo.getTransferByProviderReference({
      provider,
      providerReference,
      organizationId: auth.organizationId,
      projectId: auth.projectId,
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
    // Helius-backed path: fetch on-chain signatures for the wallet address, then
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

    // 1. Fetch on-chain signature history via Helius (or fallback RPC)
    const heliusRpc = createSignatureHistoryRpc(c.env);
    const ownerAddress = sourceAddress as Address;
    const historyLimit = Math.min(pageSize * 5, 200);
    const signatureSearchAddresses: Address[] = [ownerAddress];

    {
      const tokenAccountAddresses = await resolveWalletTokenAccountAddresses(
        c,
        heliusRpc,
        ownerAddress,
        resolvedWalletId
      );

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
    }

    const ownerSignatures = await solanaRpc.getSignaturesForAddress(heliusRpc, ownerAddress, {
      limit: historyLimit,
      commitment: "confirmed",
    });
    const tokenAccountSignatureResults = await mapSettledWithConcurrency(
      signatureSearchAddresses.slice(1),
      SIGNATURE_HISTORY_LOOKUP_CONCURRENCY,
      (searchAddress) =>
        solanaRpc.getSignaturesForAddress(heliusRpc, searchAddress, {
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

    // 2. Load the exact persisted ledger first. Fetching the first N persisted
    // rows is sufficient for page N after observed rows are merged: observations
    // can only push persisted rows later in the combined ordering.
    const persistedResult = await repo.listTransfers({
      organizationId: auth.organizationId,
      projectId: auth.projectId,
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

    // 3. Look up every observed signature in our DB before synthesizing rows.
    // A persisted exact row remains authoritative even when it falls outside
    // the requested page or filters.
    const persistedSignatureRows = await repo.listTransfersBySignatures({
      signatures: sigStrings,
      organizationId: auth.organizationId,
      projectId: auth.projectId,
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
    const observedRows = await buildObservedTransfersForSignatures(
      c.env,
      missingObservedSignatures,
      {
        organizationId: auth.organizationId,
        projectId: auth.projectId,
        walletIdsByAddress,
      }
    );

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
      projectId: auth.projectId,
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
    projectId: auth.projectId,
  });

  if (!row) throw new AppError("NOT_FOUND", "Transfer not found");
  assertTransferReadAccess(c, row);

  return success(c, { transfer: mapTransferRow(row) });
}
