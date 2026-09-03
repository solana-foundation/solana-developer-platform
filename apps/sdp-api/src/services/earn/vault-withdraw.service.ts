import { notImplemented } from "@sdp/earn/errors";
import type { EarnRuntimeContext, EarnVaultTransactionPlan } from "@sdp/earn/types";
import { compareDecimalAmounts } from "@sdp/solana/amount";
import type { SdpEnvironment } from "@sdp/types";
import { type AppDb, getDb } from "@/db";
import {
  assertMovementIsOwnReplay,
  createPostgresEarnMovementsRepository,
  type EarnMovementRow,
  type EarnPositionRow,
} from "@/db/repositories/earn-movements.repository";
import { badRequest, internalError } from "@/lib/errors";
import { buildEarnVaultWithdrawalFingerprint, resolveIdempotencyReplay } from "@/lib/idempotency";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";
import {
  earnClusterFor,
  resolveClusterRpcUrl,
  resolveVaultWithdrawClient,
} from "./execution-registry";
import { createVaultDeadline } from "./vault-deadline";
import { appendVaultRequestMemo } from "./vault-execution.service";
import { executeSignedVaultIntent } from "./vault-intent-execution.service";
import { refusedBuildMessage } from "./vault-refusals";
import { resolveVaultSponsorship, vaultRentPayer } from "./vault-sponsorship";

/**
 * Exit a non-custodial vault position with one transaction.
 *
 * The safety order is the same as deposit: build, simulate, sign, record, send.
 * The signed movement is persisted before any bytes reach the network, so an
 * ambiguous broadcast remains recoverable by the shared vault reconciler.
 * Plans that do not fit one Solana transaction are rejected before recording.
 */
export interface VaultWithdrawalInput {
  organizationId: string;
  projectId: string;
  environment: SdpEnvironment;
  provider: string;
  positionId: string;
  vaultAddress: string;
  tokenMint: string;
  shareMint: string;
  wallet: { id: string; walletId: string; publicKey: string };
  shares: string;
  /** Exit slippage floor in the deposit token's units; provider-dependent. */
  minAmountOut?: string;
  requestId: string;
  userId?: string | null;
  apiKeyId?: string | null;
}

export interface VaultWithdrawalResult {
  position: EarnPositionRow;
  movement: EarnMovementRow;
  /** True when an existing signed movement won; its bytes were not re-sent. */
  replayed: boolean;
}

export interface VaultWithdrawalExecutionOptions {
  /** Couple an approved-operation effect fence to the first durable mutation. */
  runIntentTransaction?: <T>(mutation: (db: AppDb) => Promise<T>) => Promise<T>;
}

/**
 * Shared with the external-wallet withdrawal build, whose plan must pass the
 * same bar.
 *
 * The accepted floor is checked here but deliberately NOT persisted yet: the
 * deposit's `min_shares_out` column is documented as SHARE units, so a
 * token-unit exit floor needs its own column and migration. Until that
 * follow-up lands, the signed transaction bytes remain the durable record of
 * what floor was actually encoded.
 */
export function requireAcceptedWithdrawalPlan(
  plan: EarnVaultTransactionPlan,
  input: Pick<VaultWithdrawalInput, "tokenMint" | "shareMint" | "shares" | "minAmountOut">
): void {
  if (plan.assetIdentity.depositTokenMint !== input.tokenMint) {
    throw internalError(
      "Vault builder deposit token mint does not match the position being exited"
    );
  }
  if (plan.assetIdentity.shareMint !== input.shareMint) {
    throw internalError("Vault builder share mint does not match the position being exited");
  }
  const shares = plan.accepted?.shares;
  if (!shares) {
    throw internalError("Vault builder did not report the canonical shares encoded on chain");
  }
  if (compareDecimalAmounts(shares, input.shares) !== 0) {
    throw internalError("Vault builder shares do not match the requested withdrawal");
  }
  // Same rule as the deposit's floor: what the instructions ENCODE must match
  // what policy approved, in both directions of disagreement.
  const minAmountOut = plan.accepted?.minAmountOut ?? null;
  if (input.minAmountOut !== undefined && minAmountOut === null) {
    throw internalError("Vault builder omitted the canonical minAmountOut encoded on chain");
  }
  if (
    (input.minAmountOut === undefined && minAmountOut !== null) ||
    (input.minAmountOut !== undefined &&
      minAmountOut !== null &&
      compareDecimalAmounts(minAmountOut, input.minAmountOut) !== 0)
  ) {
    throw internalError(
      "Vault builder minAmountOut does not match the policy-approved slippage floor"
    );
  }
}

async function replayResult(
  ledger: ReturnType<typeof createPostgresEarnMovementsRepository>,
  input: VaultWithdrawalInput,
  movement: EarnMovementRow
): Promise<VaultWithdrawalResult> {
  if (movement.direction !== "withdrawal") {
    throw internalError(`Replayed movement ${movement.id} is not a vault withdrawal`);
  }
  const position = await ledger.getPositionById({
    organizationId: input.organizationId,
    environment: input.environment,
    positionId: movement.position_id,
  });
  if (!position || !movement.signature) {
    throw internalError(`Replayed withdrawal ${movement.id} references missing execution details`);
  }
  return { position, movement, replayed: true };
}

export async function withdrawFromVault(
  env: Env,
  input: VaultWithdrawalInput,
  options: VaultWithdrawalExecutionOptions = {}
): Promise<VaultWithdrawalResult> {
  const ledger = createPostgresEarnMovementsRepository(getDb(env));
  const fingerprint = buildEarnVaultWithdrawalFingerprint({
    environment: input.environment,
    provider: input.provider,
    positionId: input.positionId,
    shares: input.shares,
    minAmountOut: input.minAmountOut ?? null,
  });

  const prior = await resolveIdempotencyReplay(
    () =>
      ledger.findVaultMovementByRequestId({
        organizationId: input.organizationId,
        requestId: input.requestId,
      }),
    fingerprint
  );
  if (prior) {
    assertMovementIsOwnReplay(prior, {
      projectId: input.projectId,
      idempotencyFingerprint: fingerprint,
    });
    return replayResult(ledger, input, prior);
  }

  const deadline = createVaultDeadline();
  const client = resolveVaultWithdrawClient(env, input.provider, deadline);
  if (!client) throw notImplemented(input.provider, "vault withdrawals");

  const cluster = earnClusterFor(input.environment);
  const rpcUrl = resolveClusterRpcUrl(env, cluster);

  // Same ordering rule as deposit: after the replay reads, before the build.
  //
  // Sponsorship matters here mostly for the FEE. klend's exit emits an
  // idempotent create for the owner's deposit-token ATA, which normally costs
  // nothing because that account had to exist for the deposit to succeed, but
  // SDP does not enforce that: nothing here closes it, and nothing stops the
  // owner closing it once a full-balance deposit leaves it empty. `rentPayer` is
  // passed regardless, so the two directions read the same and a provider whose
  // exit DOES create an account is covered without another change here. What is
  // NOT covered: only the SHARE ATA's rent is attributed and refunded, so rent
  // this exit pays for any other account is charged to the sponsor and stays
  // there.
  const fee = await resolveVaultSponsorship(env, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    walletId: input.wallet.id,
    cluster,
    deadline,
  });
  const rentPayer = vaultRentPayer(fee);
  const expectedAssetIdentity = {
    depositTokenMint: input.tokenMint,
    shareMint: input.shareMint,
  };
  const runtime: EarnRuntimeContext = { env, environment: input.environment };

  // Who gets the share-ATA rent back when this exit empties the account. Read
  // from the position rather than derived from the CURRENT fee mode: the rent
  // was paid at deposit time, and sponsorship may have been toggled since.
  // Refunding a sponsor for rent the customer paid would take the customer's
  // lamports, so the recorded funder is the only safe source. Null means the
  // custody wallet funded it and keeps it.
  const position = await ledger.getPositionById({
    organizationId: input.organizationId,
    environment: input.environment,
    positionId: input.positionId,
  });
  if (!position) {
    // A miss is not a "nobody sponsored this" answer, it is an unanswerable
    // question. The route resolves this same org+environment-scoped id before
    // it calls in, so a null here is a broken invariant, and the owner fallback
    // it used to take would hand the customer rent that a sponsor paid.
    throw internalError(`Vault withdrawal references missing position ${input.positionId}`);
  }
  const rentRefundTo = position.share_ata_rent_funder ?? undefined;

  let plan: EarnVaultTransactionPlan;
  try {
    const built = await client.buildVaultWithdrawal(runtime, {
      providerReference: input.vaultAddress,
      owner: input.wallet.publicKey,
      shares: input.shares,
      ...(rentPayer === undefined ? {} : { rentPayer }),
      ...(rentRefundTo === undefined ? {} : { rentRefundTo }),
      minAmountOut: input.minAmountOut,
    });
    plan = appendVaultRequestMemo(built, "vault-withdrawal", input.requestId);
  } catch (error) {
    getLogger().error({ error }, "vault withdrawal: build failed before signing");
    const refusal = refusedBuildMessage(error);
    if (refusal) throw badRequest(refusal);
    throw error;
  }

  if (plan.cluster !== cluster) {
    throw internalError(
      `Vault builder returned a ${plan.cluster} plan for the configured ${cluster} cluster`
    );
  }
  requireAcceptedWithdrawalPlan(plan, input);

  return executeSignedVaultIntent({
    operation: "withdrawal",
    env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    walletId: input.wallet.id,
    walletPublicKey: input.wallet.publicKey,
    signerMismatchMessage: "Resolved signing wallet does not match the position's wallet",
    cluster,
    deadline,
    expectedAssetIdentity,
    plan,
    rpcUrl,
    fee,
    runIntentTransaction: options.runIntentTransaction,
    persist: (db, signed) =>
      createPostgresEarnMovementsRepository(db).createSignedVaultWithdrawalIntent({
        organizationId: input.organizationId,
        projectId: input.projectId,
        environment: input.environment,
        provider: input.provider,
        positionId: input.positionId,
        vaultAddress: input.vaultAddress,
        custodyWalletId: input.wallet.id,
        shareMint: input.shareMint,
        requestedShares: input.shares,
        walletAddress: input.wallet.publicKey,
        signature: signed.signature,
        signedTransaction: Buffer.from(signed.bytes).toString("base64"),
        lastValidBlockHeight: signed.lastValidBlockHeight,
        requestId: input.requestId,
        idempotencyFingerprint: fingerprint,
        createdBy: input.userId ?? null,
        initiatedByKeyId: input.apiKeyId ?? null,
        // An exit can create the share account as a prerequisite and pay its
        // rent, so it owns the attribution from that point on.
        createsShareAccount: plan.createsShareAccount === true,
        shareAtaRentFunder: rentPayer ?? null,
      }),
  });
}
