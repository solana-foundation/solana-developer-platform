import { notImplemented } from "@sdp/earn/errors";
import type { EarnRuntimeContext, EarnVaultTransactionPlan } from "@sdp/earn/types";
import { SdpKaminoError } from "@sdp/kamino";
import { compareDecimalAmounts } from "@sdp/solana/amount";
import type { SdpEnvironment } from "@sdp/types";
import { address } from "@solana/kit";
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
import * as solanaServices from "@/services/solana";
import type { Env } from "@/types/env";
import {
  earnClusterFor,
  resolveClusterRpcUrl,
  resolveVaultWithdrawClient,
} from "./execution-registry";
import { createVaultDeadline } from "./vault-deadline";
import {
  appendVaultRequestMemo,
  broadcastVaultTransaction,
  type SignedVaultTransaction,
  signVaultPlan,
  simulateVaultPlan,
} from "./vault-execution.service";

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

function requireAcceptedWithdrawalPlan(
  plan: EarnVaultTransactionPlan,
  input: Pick<VaultWithdrawalInput, "tokenMint" | "shareMint" | "shares">
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
  const expectedAssetIdentity = {
    depositTokenMint: input.tokenMint,
    shareMint: input.shareMint,
  };
  const runtime: EarnRuntimeContext = { env, environment: input.environment };

  let plan: EarnVaultTransactionPlan;
  try {
    const built = await client.buildVaultWithdrawal(runtime, {
      providerReference: input.vaultAddress,
      owner: input.wallet.publicKey,
      shares: input.shares,
    });
    plan = appendVaultRequestMemo(built, "vault-withdrawal", input.requestId);
  } catch (error) {
    getLogger().error({ error }, "vault withdrawal: build failed before signing");
    if (error instanceof SdpKaminoError && error.code === "INVALID_AMOUNT") {
      throw badRequest(error.message);
    }
    throw error;
  }

  if (plan.cluster !== cluster) {
    throw internalError(
      `Vault builder returned a ${plan.cluster} plan for the configured ${cluster} cluster`
    );
  }
  requireAcceptedWithdrawalPlan(plan, input);

  try {
    const simulation = await simulateVaultPlan(env, {
      cluster,
      deadline,
      expectedAssetIdentity,
      plan,
      owner: address(input.wallet.publicKey),
      rpcUrl,
    });
    if (!simulation.ok) {
      getLogger().error(
        { error: simulation.error, logs: simulation.logs.slice(-5) },
        "vault withdrawal: simulation failed before signing"
      );
      throw badRequest(`Vault withdrawal simulation failed: ${simulation.error}`);
    }
  } catch (error) {
    if (
      !(error instanceof Error && error.message.startsWith("Vault withdrawal simulation failed:"))
    ) {
      getLogger().error({ error }, "vault withdrawal: simulation call failed before signing");
    }
    throw error;
  }

  let signed: SignedVaultTransaction;
  try {
    const signer = await deadline.run("Resolving the vault withdrawal signer", () =>
      solanaServices.createOrgSignerForCustodyWallet(
        env,
        input.organizationId,
        input.projectId,
        input.wallet.id
      )
    );
    if (signer.address !== input.wallet.publicKey) {
      throw badRequest("Resolved signing wallet does not match the position's wallet");
    }
    signed = await signVaultPlan(env, {
      cluster,
      deadline,
      expectedAssetIdentity,
      plan,
      owner: signer,
      rpcUrl,
      fee: { kind: "wallet-pays" },
    });
  } catch (error) {
    getLogger().error({ error }, "vault withdrawal: signer resolution or signing failed");
    throw error;
  }

  const runIntentTransaction =
    options.runIntentTransaction ??
    (<T>(mutation: (db: AppDb) => Promise<T>) => mutation(getDb(env)));
  const result = await runIntentTransaction((db) =>
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
    })
  );

  if (result.replayed) return result;

  try {
    await broadcastVaultTransaction(env, {
      cluster,
      deadline,
      bytes: signed.bytes,
      rpcUrl,
    });
  } catch (error) {
    getLogger().error(
      { movementId: result.movement.id, signature: signed.signature, error },
      "vault withdrawal: broadcast outcome unknown; left reconcilable"
    );
    return result;
  }

  const advanced = await ledger.advanceVaultMovement({
    movementId: result.movement.id,
    organizationId: input.organizationId,
    toStatus: "submitted",
  });
  if (advanced) return { ...result, movement: advanced };

  const observed = await ledger.getMovementById({
    movementId: result.movement.id,
    organizationId: input.organizationId,
  });
  if (observed?.signature === signed.signature) {
    return { ...result, movement: observed };
  }
  throw internalError(
    "Vault withdrawal was broadcast but its ledger transition could not be verified"
  );
}
