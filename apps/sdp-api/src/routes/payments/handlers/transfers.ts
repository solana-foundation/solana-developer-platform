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
import { buildPaymentTransferFingerprint, resolveIdempotencyReplay } from "@/lib/idempotency";
import { paginated, success } from "@/lib/response";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import { enforceMeteredQuota } from "@/middleware/metered-quota";
import { getPolicyGateContext, type PolicyGateExtraction } from "@/middleware/policy-gate";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { getLogger } from "@/runtime/logger";
import { logEvent } from "@/runtime/money-path-events";
import {
  assertApiKeyWalletAccess,
  getAllowedApiKeyWalletIdsForPermissions,
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
  approvedWalletOperationAttemptId,
  approvedWalletOperationId,
  beginApprovedWalletOperationEffect,
  runApprovedWalletOperationEffectTransaction,
} from "@/services/policy/approved-operation-replay";
import {
  enforceWalletOperationPolicy,
  walletOperationActorFromAuth,
} from "@/services/policy/enforcement.service";
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
import { type ResolvedScope, resolveScope, resolveWallet } from "../wallets";
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
  fingerprint: string
): Promise<TransferRow | null> {
  return resolveIdempotencyReplay(
    () => repository.findTransferByIdempotency({ organizationId, projectId, idempotencyKey }),
    fingerprint
  );
}

async function createTransferRecord(
  c: AppContext,
  input: {
    organizationId: string;
    projectId: string | null;
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
  const idempotencyFingerprint = idempotencyKey
    ? buildPaymentTransferFingerprint({
        sourceAddress: input.sourceAddress,
        destinationAddress: input.destinationAddress,
        token: input.token,
        amount: input.amount,
        memo: input.memo,
        type: input.type ?? "transfer",
        privateTransfer: input.privateTransfer,
      })
    : null;

  try {
    return await runApprovedWalletOperationEffectTransaction(c, async (db) => {
      const repository = createPostgresPaymentsRepository(db, getRequestTenantScope(c));

      if (idempotencyKey && idempotencyFingerprint) {
        const existing = await resolveTransferIdempotencyReplay(
          repository,
          input.organizationId,
          input.projectId,
          idempotencyKey,
          idempotencyFingerprint
        );
        if (existing) {
          return { row: existing, replayed: true };
        }
      }

      const createdRow = await repository.createTransfer({
        id: generatePaymentTransferId(),
        organizationId: input.organizationId,
        projectId: input.projectId,
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
        idempotencyFingerprint,
      });

      if (!createdRow) {
        throw new AppError("INTERNAL_ERROR", "Failed to create payment transfer record");
      }

      return { row: createdRow, replayed: false };
    });
  } catch (error) {
    if (idempotencyKey && idempotencyFingerprint && isPostgresUniqueViolation(error)) {
      const existing = await resolveTransferIdempotencyReplay(
        getPaymentsRepository(c),
        input.organizationId,
        input.projectId,
        idempotencyKey,
        idempotencyFingerprint
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

async function enforcePaymentTransferOperationPolicy(
  c: AppContext,
  scope: ResolvedScope,
  operation: OutboundPaymentOperation,
  input: {
    operationType: "payment_transfer_execute";
    memo?: string;
    privateTransfer?: boolean;
    rawPayload?: Record<string, unknown>;
  }
) {
  return enforceWalletOperationPolicy(
    c.env,
    getRequestTenantScope(c),
    {
      ...buildTransferPolicyCandidate(scope, operation, {
        memo: input.memo === undefined ? null : input.memo,
        privateTransfer: input.privateTransfer === true,
      }),
      legs: [],
      rawPayload: input.rawPayload,
    },
    approvedWalletOperationId(c),
    approvedWalletOperationAttemptId(c)
  );
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

  const scope = await resolveScope(c);
  assertPaymentProjectScope(body.projectId, scope.auth.projectId);
  const operation = resolveOutboundPaymentOperation({
    auth: scope.auth,
    wallets: scope.wallets,
    source: body.source,
    destination: body.destination,
    token: body.token,
    amount: body.amount,
    env: c.env,
    requiredWalletPermissions: ["payments:write"],
  });
  const privateTransfer = body.privateTransfer as PrivateTransferRequest | undefined;

  return {
    candidate: buildTransferPolicyCandidate(scope, operation, {
      memo: body.memo === undefined ? null : body.memo,
      privateTransfer: Boolean(privateTransfer),
    }),
    legs: [],
    body,
    resolved: { scope, operation, privateTransfer },
    rawPayload: {
      source: body.source,
      destination: body.destination,
      token: body.token,
      amount: body.amount,
    },
    idempotencyKey: null,
  };
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

  const replay = await resolveTransferIdempotencyReplay(
    getPaymentsRepository(c),
    scope.auth.organizationId,
    scope.auth.projectId,
    idempotencyKey,
    buildPaymentTransferFingerprint({
      sourceAddress: operation.sourceWallet.publicKey,
      destinationAddress: body.destination,
      token: operation.token,
      amount: operation.amount,
      memo: body.memo,
      type: privateTransfer ? "transfer_confidential" : "transfer",
      privateTransfer,
    })
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
  const signer = await solanaServices.createOrgSigner(
    c.env,
    auth.organizationId,
    auth.projectId ?? undefined,
    sourceWallet.walletId
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

async function executePreparedPrivateTransfer(
  c: AppContext,
  scope: ResolvedScope,
  operation: OutboundPaymentOperation,
  serializedTx: string,
  lastValidBlockHeight: bigint,
  metadata: PreparedPrivateTransferMetadata,
  submissionStore: SignedSubmissionStore
): Promise<{ signature: string; slot: number | null; blockTime: string | null }> {
  const walletsByAddress = new Map(scope.wallets.map((wallet) => [wallet.publicKey, wallet]));
  const signerWallets = new Map<string, CustodyWallet>();
  const requiredSigners = [...new Set(metadata.magicBlock.requiredSigners)];
  const decodedTransaction = decodeMagicBlockPreparedTransaction(serializedTx);
  const existingFeePayer = decodedTransaction.existingFeePayer;
  const shouldReplaceProviderFeePayer =
    requiredSigners.includes(existingFeePayer) && !walletsByAddress.has(existingFeePayer);
  const custodyRequiredSigners = shouldReplaceProviderFeePayer
    ? requiredSigners.filter((signer) => signer !== existingFeePayer)
    : requiredSigners;

  for (const requiredSigner of custodyRequiredSigners) {
    const wallet = walletsByAddress.get(requiredSigner);
    if (wallet) {
      signerWallets.set(wallet.publicKey, wallet);
    }
  }

  const missingSignerCount = custodyRequiredSigners.length - signerWallets.size;
  if (missingSignerCount > 0) {
    throw new AppError(
      "BAD_REQUEST",
      "MagicBlock private transfer requires signer(s) that are not controlled by SDP."
    );
  }

  // Provider-declared signers are untrusted: authorize the complete custody signer set before
  // resolving any private keys so one denied signer cannot still produce partial signatures.
  for (const wallet of signerWallets.values()) {
    assertApiKeyWalletAccess(scope.auth, wallet.walletId, ["payments:write"]);
  }

  for (const wallet of signerWallets.values()) {
    // The source wallet's operation policy was enforced before preparation.
    if (wallet.walletId === operation.sourceWallet.walletId) {
      continue;
    }

    const signerOperation = {
      ...operation,
      sourceAddress: assertValidAddress(wallet.publicKey, "required signer"),
      sourceWallet: wallet,
    };
    await enforcePaymentTransferOperationPolicy(c, scope, signerOperation, {
      operationType: "payment_transfer_execute",
      privateTransfer: true,
      rawPayload: {
        source: wallet.walletId,
        destination: operation.destinationAddress,
        token: operation.token,
        amount: operation.amount,
      },
    });
  }

  const signers = await Promise.all(
    [...signerWallets.values()].map(async (wallet) => {
      const signer = await solanaServices.createOrgSigner(
        c.env,
        scope.auth.organizationId,
        scope.auth.projectId ?? undefined,
        wallet.walletId
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
    decodedTransaction,
    feePayer,
    custodyRequiredSigners,
    { replaceExistingFeePayer: shouldReplaceProviderFeePayer }
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
  const signer = await solanaServices.createOrgSigner(
    c.env,
    auth.organizationId,
    auth.projectId ?? undefined,
    sourceWallet.walletId
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
    const { row: transfer, replayed } = await createTransferRecord(c, {
      organizationId: scope.auth.organizationId,
      projectId: scope.auth.projectId,
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
        operation,
        mapped.prepared.serializedTx,
        BigInt(mapped.prepared.lastValidBlockHeight),
        mapped.metadata,
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
  resolvedWalletId: string;
  walletIdsByAddress: Map<string, string>;
}

/**
 * Resolves which tenant-owned wallet an observed (on-chain) transfer lookup
 * may run against. On-chain history is restricted to tenant-owned wallets: a
 * walletAddress that matches no org wallet returns null, steering the caller
 * to the DB-only path instead of driving RPC fan-out against an arbitrary
 * address.
 *
 * @throws AppError FORBIDDEN when the API key's wallet bindings exclude the
 *   requested wallet; NOT_FOUND (via resolveWallet) for an unknown walletId.
 */
function resolveObservedTransferTarget(
  scope: ResolvedScope,
  params: {
    walletId: string | undefined;
    walletAddress: string | undefined;
    allowedWalletIds: string[] | null;
  }
): ObservedTransferTarget | null {
  const { walletId, walletAddress, allowedWalletIds } = params;

  if (walletId) {
    const wallet = resolveWallet(scope.wallets, walletId);
    assertApiKeyWalletAccess(scope.auth, wallet.walletId, ["payments:read"]);
    return {
      sourceAddress: wallet.publicKey,
      resolvedWalletId: wallet.walletId,
      walletIdsByAddress: new Map([[wallet.publicKey, wallet.walletId]]),
    };
  }

  if (allowedWalletIds) {
    const authorizedWallet = scope.wallets.find(
      (wallet) => wallet.publicKey === walletAddress && allowedWalletIds.includes(wallet.walletId)
    );
    if (!authorizedWallet) {
      throw new AppError("FORBIDDEN", "API key is not authorized for the requested wallet");
    }

    return {
      sourceAddress: authorizedWallet.publicKey,
      resolvedWalletId: authorizedWallet.walletId,
      walletIdsByAddress: new Map([[authorizedWallet.publicKey, authorizedWallet.walletId]]),
    };
  }

  const matchedWallet = scope.wallets.find((wallet) => wallet.publicKey === walletAddress);
  if (!matchedWallet) {
    return null;
  }

  return {
    sourceAddress: matchedWallet.publicKey,
    resolvedWalletId: matchedWallet.walletId,
    walletIdsByAddress: new Map([[matchedWallet.publicKey, matchedWallet.walletId]]),
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Wallet-scoped transfer listing merges DB rows with observed on-chain history.
export async function listTransfers(c: AppContext) {
  const auth = getAuth(c);
  const query = listTransfersQuerySchema.safeParse(c.req.query());
  if (!query.success) throw badRequestQuery();
  const allowedWalletIds = getAllowedApiKeyWalletIdsForPermissions(auth, ["payments:read"]);

  const {
    page,
    pageSize,
    wallet: walletId,
    walletAddress,
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

  if (walletId && allowedWalletIds && !allowedWalletIds.includes(walletId)) {
    throw new AppError("FORBIDDEN", "API key is not authorized for the requested wallet");
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

    if (row && allowedWalletIds && !allowedWalletIds.includes(row.wallet_id)) {
      throw new AppError("FORBIDDEN", "API key is not authorized for the requested wallet");
    }
  }

  let transferRows: TransferRow[];
  let total: number;

  // On-chain history may only be pulled for tenant-owned wallets. The target
  // is resolved before choosing a path so an unowned walletAddress falls
  // through to the DB-only branch instead of driving RPC fan-out against an
  // arbitrary address.
  let observedScope: ResolvedScope | null = null;
  let observedTarget: ObservedTransferTarget | null = null;

  if ((walletId || walletAddress) && includeObserved && !hasExactProviderReference) {
    observedScope = await resolveScope(c);
    observedTarget = resolveObservedTransferTarget(observedScope, {
      walletId,
      walletAddress,
      allowedWalletIds,
    });
  }

  if (observedTarget) {
    // Helius-backed path: fetch on-chain signatures for the wallet address, then
    // cross-reference with our DB. Append pending/processing/failed from DB (not on-chain yet).
    //
    // TODO: Replace getSignaturesForAddress with a dedicated indexer for production use.

    // Metered per tenant and actor, failing closed: this path fans out to the
    // billed RPC and must not run unmetered through a limiter outage.
    await enforceMeteredQuota(c, { name: "observed-transfers", actorMax: 30, orgMax: 120 });

    const { sourceAddress, resolvedWalletId, walletIdsByAddress } = observedTarget;

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

    // 2. Look up on-chain signatures in our DB
    const confirmedRows = await repo.listTransfersBySignatures({
      signatures: sigStrings,
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });
    const scopedConfirmedRows = allowedWalletIds
      ? confirmedRows.filter((row) => allowedWalletIds.includes(row.wallet_id))
      : confirmedRows;

    // 3. Fetch pending/processing/failed from DB (not yet on-chain).
    //    Skip if the caller's status filter already excludes these — e.g. status=confirmed
    //    or status=finalized would never match any of these records.
    const nonChainStatuses: TransferStatus[] = [
      "pending",
      "processing",
      "failed",
      "awaiting_payment",
      "settling",
      "completed",
      "canceled",
      "expired",
    ];
    const needsNonChainRecords =
      !statuses || statuses.some((value) => nonChainStatuses.includes(value));
    const pendingRows: TransferRow[] = [];
    if (needsNonChainRecords) {
      const pendingResult = await repo.listTransfers({
        organizationId: auth.organizationId,
        projectId: auth.projectId,
        walletId: resolvedWalletId,
        walletIds: resolvedWalletId ? undefined : (allowedWalletIds ?? undefined),
        walletAddress: resolvedWalletId ? undefined : walletAddress,
        counterpartyId,
        search,
        statuses: nonChainStatuses,
        types: transferTypes,
        provider,
        token: tokenFilter,
        direction,
        createdAtFrom: from,
        createdAtTo: to,
        sortBy,
        sortDirection,
        limit: 100,
        offset: 0,
      });
      pendingRows.push(...pendingResult.rows);
    }

    const confirmedSignatures = new Set(
      scopedConfirmedRows
        .map((row) => row.signature)
        .filter((rowSignature): rowSignature is string => Boolean(rowSignature))
    );
    const missingObservedSignatures = onChainSigs.filter(
      (signatureInfo) => !confirmedSignatures.has(String(signatureInfo.signature))
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

    // 4. Merge: confirmed (Helius-backed) + non-confirmed (DB), deduplicated
    const seen = new Set<string>();
    const merged = [...scopedConfirmedRows, ...observedRows, ...pendingRows].filter((row) => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    });

    // 5. Apply remaining filters and sort
    const filtered = merged
      .filter((row) =>
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
      )
      .sort((left, right) => compareTransferRows(left, right, sortBy, sortDirection));

    total = filtered.length;
    transferRows = filtered.slice(offset, offset + pageSize);
  } else {
    // DB-only path for org-scoped queries without a specific wallet
    let resolvedDatabaseWalletId = walletId;
    let unresolvedDatabaseWalletAddress: string | undefined;

    if (!resolvedDatabaseWalletId && walletAddress) {
      const scope = observedScope ?? (await resolveScope(c));
      const matchedWallet = scope.wallets.find((wallet) => wallet.publicKey === walletAddress);

      if (matchedWallet) {
        if (allowedWalletIds && !allowedWalletIds.includes(matchedWallet.walletId)) {
          throw new AppError("FORBIDDEN", "API key is not authorized for the requested wallet");
        }
        resolvedDatabaseWalletId = matchedWallet.walletId;
      } else {
        if (allowedWalletIds) {
          throw new AppError("FORBIDDEN", "API key is not authorized for the requested wallet");
        }
        unresolvedDatabaseWalletAddress = walletAddress;
      }
    }

    if (
      !resolvedDatabaseWalletId &&
      !unresolvedDatabaseWalletAddress &&
      allowedWalletIds?.length === 0
    ) {
      return paginated(c, [], { total: 0, page, pageSize });
    }

    const queryStartedAt = performance.now();
    const result = await repo.listTransfers({
      organizationId: auth.organizationId,
      projectId: auth.projectId,
      walletId: resolvedDatabaseWalletId,
      walletIds: resolvedDatabaseWalletId ? undefined : (allowedWalletIds ?? undefined),
      walletAddress: walletId ? walletAddress : unresolvedDatabaseWalletAddress,
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

  const transfers = transferRows.map(mapTransferRow);
  return paginated(c, transfers, { total, page, pageSize });
}

export async function getTransfer(c: AppContext) {
  const auth = getAuth(c);
  const allowedWalletIds = getAllowedApiKeyWalletIdsForPermissions(auth, ["payments:read"]);
  const params = transferIdParamsSchema.safeParse(c.req.param());
  const repo = getPaymentsRepository(c);

  if (!params.success) throw badRequest("Transfer ID is required");

  const row = await repo.getTransferById({
    transferId: params.data.transferId,
    organizationId: auth.organizationId,
    projectId: auth.projectId,
  });

  if (!row) throw new AppError("NOT_FOUND", "Transfer not found");
  if (allowedWalletIds && !allowedWalletIds.includes(row.wallet_id)) {
    throw new AppError("FORBIDDEN", "API key is not authorized for the requested wallet");
  }

  return success(c, { transfer: mapTransferRow(row) });
}
