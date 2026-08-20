import { notImplemented } from "@sdp/earn/errors";
import type { EarnRuntimeContext, EarnVaultTransactionPlan } from "@sdp/earn/types";
import { SdpKaminoError } from "@sdp/kamino";
import { compareDecimalAmounts } from "@sdp/solana/amount";
import type { SdpEnvironment } from "@sdp/types";
import type { EarnProviderId } from "@sdp/types/provider-access";
import { address } from "@solana/kit";
import { type AppDb, getDb } from "@/db";
import {
  assertMovementIsOwnReplay,
  createPostgresEarnMovementsRepository,
  type EarnMovementRow,
  type EarnPositionRow,
} from "@/db/repositories/earn-movements.repository";
import { badRequest, internalError } from "@/lib/errors";
import { buildEarnVaultDepositFingerprint, resolveIdempotencyReplay } from "@/lib/idempotency";
import { getLogger } from "@/runtime/logger";
import * as solanaServices from "@/services/solana";
import type { Env } from "@/types/env";
import {
  earnClusterFor,
  resolveClusterRpcUrl,
  resolveVaultDirectClient,
} from "./execution-registry";
import { createVaultDeadline } from "./vault-deadline";
import {
  broadcastVaultTransaction,
  type SignedVaultTransaction,
  signVaultPlan,
  simulateVaultPlan,
} from "./vault-execution.service";

// biome-ignore lint/security/noSecrets: public Solana Memo program address.
const MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

/**
 * Deposit ordering is deliberately `build → simulate → sign → record → send`.
 * Signing alone cannot move funds. Recording the signed transaction and its
 * position atomically before broadcast removes unsigned intents, makes a crash
 * recoverable by signature, and lets an idempotency loser stop before sending.
 */

export interface VaultDepositInput {
  organizationId: string;
  projectId: string;
  environment: SdpEnvironment;
  provider: EarnProviderId;
  /** Vault address — the strategy's providerReference. */
  providerReference: string;
  wallet: { id: string; walletId: string; publicKey: string };
  /** Trusted catalogue metadata persisted so delisted positions still render. */
  tokenMint: string;
  shareMint: string;
  label: string;
  /** Decimal string in the vault token's units. */
  amount: string;
  /** Caller idempotency key. */
  requestId: string;
  userId?: string | null;
  apiKeyId?: string | null;
  /** Slippage floor, decimal string. */
  minSharesOut?: string;
}

export interface VaultDepositResult {
  position: EarnPositionRow;
  movement: EarnMovementRow;
  /** True when an existing signed movement won; its bytes were not re-sent. */
  replayed: boolean;
}

export interface VaultDepositExecutionOptions {
  /**
   * Handler-owned boundary that couples an approved-operation effect fence to
   * the repository's first durable mutation. The repository still opens a real
   * transaction for ordinary calls.
   */
  runIntentTransaction?: <T>(mutation: (db: AppDb) => Promise<T>) => Promise<T>;
}

async function replayResult(
  ledger: ReturnType<typeof createPostgresEarnMovementsRepository>,
  input: VaultDepositInput,
  movement: EarnMovementRow
): Promise<VaultDepositResult> {
  const position = await ledger.getPositionById({
    organizationId: input.organizationId,
    environment: input.environment,
    positionId: movement.position_id,
  });
  if (!position) {
    throw internalError(
      `Replayed movement ${movement.id} references missing position ${movement.position_id}`
    );
  }
  return { position, movement, replayed: true };
}

function requireAcceptedPlan(
  plan: EarnVaultTransactionPlan,
  input: Pick<VaultDepositInput, "tokenMint" | "shareMint" | "amount" | "minSharesOut">
): {
  minSharesOut: string | null;
} {
  if (plan.assetIdentity.depositTokenMint !== input.tokenMint) {
    throw internalError(
      "Vault builder deposit token mint does not match the admitted catalogue strategy"
    );
  }
  if (plan.assetIdentity.shareMint !== input.shareMint) {
    throw internalError("Vault builder share mint does not match the admitted catalogue strategy");
  }
  const amount = plan.accepted?.amount;
  if (!amount) {
    throw internalError("Vault builder did not report the canonical amount encoded on chain");
  }
  if (compareDecimalAmounts(amount, input.amount) !== 0) {
    throw internalError("Vault builder amount does not match the policy-approved request amount");
  }
  const minSharesOut = plan.accepted?.minSharesOut ?? null;
  if (input.minSharesOut !== undefined && minSharesOut === null) {
    throw internalError("Vault builder omitted the canonical minSharesOut encoded on chain");
  }
  if (
    (input.minSharesOut === undefined && minSharesOut !== null) ||
    (input.minSharesOut !== undefined &&
      minSharesOut !== null &&
      compareDecimalAmounts(minSharesOut, input.minSharesOut) !== 0)
  ) {
    throw internalError(
      "Vault builder minSharesOut does not match the policy-approved slippage floor"
    );
  }
  return { minSharesOut };
}

function appendRequestMemo(
  plan: EarnVaultTransactionPlan,
  requestId: string
): EarnVaultTransactionPlan {
  const memo = {
    programAddress: MEMO_PROGRAM_ADDRESS,
    accounts: [],
    data: Buffer.from(`sdp:earn:vault-deposit:${requestId}`, "utf8").toString("base64"),
  };
  return {
    ...plan,
    transactions: plan.transactions.map((batch) => [...batch, memo]),
  };
}

export async function depositIntoVault(
  env: Env,
  input: VaultDepositInput,
  options: VaultDepositExecutionOptions = {}
): Promise<VaultDepositResult> {
  const ledger = createPostgresEarnMovementsRepository(getDb(env));
  const fingerprint = buildEarnVaultDepositFingerprint({
    environment: input.environment,
    provider: input.provider,
    providerReference: input.providerReference,
    custodyWalletId: input.wallet.id,
    amount: input.amount,
    minSharesOut: input.minSharesOut ?? null,
  });

  // Fast sequential replay path. The atomic insert below repeats this check to
  // close the concurrent race; this read only avoids rebuilding and re-signing
  // a transaction whose signed row already exists.
  const prior = await resolveIdempotencyReplay(
    () =>
      ledger.findVaultMovementByRequestId({
        organizationId: input.organizationId,
        requestId: input.requestId,
      }),
    fingerprint
  );
  if (prior) {
    // Ownership, not just fingerprint. The lookup is org-scoped and the
    // fingerprint omits the project, so a key first used by a SIBLING project
    // matches both — and this path is reachable with the route-level guard
    // skipped (an approved-operation execution). Without this line, project B's
    // approved deposit was answered with project A's movement as replayed:true:
    // B's deposit silently never ran, and A's amount and signature leaked. Same
    // shared rule as the repository preflight; do not re-implement it here.
    assertMovementIsOwnReplay(prior, {
      projectId: input.projectId,
      idempotencyFingerprint: fingerprint,
    });
    return replayResult(ledger, input, prior);
  }

  // Replays above are pure durable reads: they must keep working during an RPC
  // outage and must never touch a chain client. Only a fresh attempt proves and
  // uses the configured endpoint.
  const deadline = createVaultDeadline();
  const client = resolveVaultDirectClient(env, input.provider, deadline);
  if (!client) {
    throw notImplemented(input.provider, "direct vault deposits");
  }
  const cluster = earnClusterFor(input.environment);
  const rpcUrl = resolveClusterRpcUrl(env, cluster);
  const expectedAssetIdentity = {
    depositTokenMint: input.tokenMint,
    shareMint: input.shareMint,
  };
  const runtime: EarnRuntimeContext = {
    env,
    environment: input.environment,
  };

  let plan: Awaited<ReturnType<typeof client.buildVaultDeposit>>;
  try {
    const built = await client.buildVaultDeposit(runtime, {
      providerReference: input.providerReference,
      owner: input.wallet.publicKey,
      amount: input.amount,
      minSharesOut: input.minSharesOut,
    });
    // Deterministic Solana signing plus a shared recent blockhash would make
    // otherwise independent requests produce the same signature. Bind the
    // caller key into the message so each ledger intent has a unique on-chain
    // identity while retries of the same key remain byte-for-byte equivalent.
    plan = appendRequestMemo(built, input.requestId);
  } catch (error) {
    getLogger().error({ error }, "vault deposit: build failed before signing");
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
  const accepted = requireAcceptedPlan(plan, input);

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
        "vault deposit: simulation failed before signing"
      );
      throw badRequest(`Vault deposit simulation failed: ${simulation.error}`);
    }
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith("Vault deposit simulation failed:"))) {
      getLogger().error({ error }, "vault deposit: simulation call failed before signing");
    }
    throw error;
  }

  let signed: SignedVaultTransaction;
  try {
    const signer = await deadline.run("Resolving the vault deposit signer", () =>
      solanaServices.createOrgSignerForCustodyWallet(
        env,
        input.organizationId,
        input.projectId,
        input.wallet.id
      )
    );
    if (signer.address !== input.wallet.publicKey) {
      throw badRequest("Resolved signing wallet does not match the deposit wallet");
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
    getLogger().error({ error }, "vault deposit: signer resolution or signing failed");
    throw error;
  }

  const runIntentTransaction =
    options.runIntentTransaction ??
    (<T>(mutation: (db: AppDb) => Promise<T>) => mutation(getDb(env)));
  const result = await runIntentTransaction((db) =>
    createPostgresEarnMovementsRepository(db).createSignedVaultDepositIntent({
      organizationId: input.organizationId,
      projectId: input.projectId,
      environment: input.environment,
      provider: input.provider,
      vaultAddress: input.providerReference,
      custodyWalletId: input.wallet.id,
      tokenMint: plan.assetIdentity.depositTokenMint,
      shareMint: plan.assetIdentity.shareMint,
      label: input.label,
      requestedAmount: input.amount,
      acceptedMinSharesOut: accepted.minSharesOut,
      // The signing wallet IS the depositor on chain, so the ledger records where
      // the money came from without a second lookup.
      sourceAddress: input.wallet.publicKey,
      signature: signed.signature,
      signedTransaction: Buffer.from(signed.bytes).toString("base64"),
      lastValidBlockHeight: signed.lastValidBlockHeight,
      requestId: input.requestId,
      idempotencyFingerprint: fingerprint,
      createdBy: input.userId ?? null,
      initiatedByKeyId: input.apiKeyId ?? null,
    })
  );

  // A concurrent identical request already owns the durable signature. Its
  // signed bytes—not ours—are the only ones that may be broadcast.
  if (result.replayed) return result;

  try {
    await broadcastVaultTransaction(env, {
      cluster,
      deadline,
      bytes: signed.bytes,
      rpcUrl,
    });
  } catch (error) {
    // Timeout/transport failure is ambiguous: the transaction may have landed.
    // Leave the signed row pending for the confirmation sweep.
    getLogger().error(
      { movementId: result.movement.id, signature: signed.signature, error },
      "vault deposit: broadcast outcome unknown; left reconcilable"
    );
    return result;
  }

  const advanced = await ledger.advanceVaultMovement({
    movementId: result.movement.id,
    organizationId: input.organizationId,
    toStatus: "submitted",
  });
  if (advanced) return { ...result, movement: advanced };

  // A confirmer may have won the CAS after broadcast. Return its newer state;
  // never fabricate the stale pending row or overwrite a terminal observation.
  const observed = await ledger.getMovementById({
    movementId: result.movement.id,
    organizationId: input.organizationId,
  });
  if (observed?.signature === signed.signature) {
    return { ...result, movement: observed };
  }
  throw internalError(
    "Vault deposit was broadcast but its ledger transition could not be verified"
  );
}
