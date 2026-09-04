import { notImplemented } from "@sdp/earn/errors";
import type { EarnRuntimeContext, EarnVaultTransactionPlan } from "@sdp/earn/types";
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
import type { Env } from "@/types/env";
import {
  earnClusterFor,
  resolveClusterRpcUrl,
  resolveVaultDirectClient,
} from "./execution-registry";
import {
  bufferedComputeUnitLimit,
  fetchJupiterSwapLeg,
  MAX_COMPUTE_UNIT_LIMIT,
  prependSwapLegToVaultPlan,
  RETRY_SWAP_MAX_ACCOUNTS,
  withComputeUnitLimit,
} from "./jupiter-swap.service";
import { createVaultDeadline } from "./vault-deadline";
import {
  appendVaultRequestMemo,
  simulateVaultPlan,
  VaultTransactionTooLargeError,
} from "./vault-execution.service";
import { executeSignedVaultIntent } from "./vault-intent-execution.service";
import { rethrowVaultProviderFailure } from "./vault-refusals";
import { resolveVaultSponsorship, type VaultFeeMode, vaultRentPayer } from "./vault-sponsorship";

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
  /**
   * Decimal string. The vault token's units ordinarily; the SOURCE token's
   * units when `swap` is present (the swap consumes it whole, and the vault
   * deposit is sized to the swap's guaranteed output).
   */
  amount: string;
  /** Caller idempotency key. */
  requestId: string;
  userId?: string | null;
  apiKeyId?: string | null;
  /** Slippage floor, decimal string. */
  minSharesOut?: string;
  /** Fund the deposit by swapping another stablecoin first (Jupiter). */
  swap?: {
    /** Validated by the route: a supported swap-source mint on this cluster. */
    sourceTokenMint: string;
    slippageBps: number;
  };
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

/** Shared with the external-wallet deposit build, whose plan must pass the same bar. */
export function requireAcceptedPlan(
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
    // Only when swap-funded, so every pre-existing fingerprint stays valid.
    ...(input.swap === undefined
      ? {}
      : {
          swapSourceTokenMint: input.swap.sourceTokenMint,
          swapSlippageBps: input.swap.slippageBps,
        }),
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

  // Resolved here, AFTER the replay reads above and BEFORE the provider builds.
  // Both halves of that sentence matter: a replay must still answer during a
  // paymaster outage, and a sponsor's address has to be inside the instructions
  // this build is about to produce.
  //
  // A swap-funded deposit deliberately never sponsors: the paymaster admits
  // only allowlisted programs, the Jupiter router and the venues it dispatches
  // to are not (and cannot statically be) on that list, and a sponsored
  // transaction would be rejected wholesale after spending a budget
  // reservation. Wallet-pays is the honest mode until swap sponsorship is a
  // deliberate design of its own.
  const fee: VaultFeeMode = input.swap
    ? { kind: "wallet-pays" }
    : await resolveVaultSponsorship(env, {
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
  const runtime: EarnRuntimeContext = {
    env,
    environment: input.environment,
  };

  /**
   * One signed-intent attempt at a given swap route width. A swap-funded
   * deposit may run it twice: the composed transaction's size is knowable only
   * after lookup-table compression inside signing, and the answer to an
   * overflow is a more compact route — which is a fresh Jupiter quote and
   * therefore a fresh provider plan, since the guaranteed output moves with
   * the route. Signing without broadcasting moves nothing, so the retry is
   * safe: the oversized bytes were refused before the durable write.
   */
  const attemptDeposit = async (maxAccounts?: number): Promise<VaultDepositResult> => {
    let depositAmount = input.amount;
    const swapLeg = input.swap
      ? await fetchJupiterSwapLeg(env, deadline, {
          inputMint: input.swap.sourceTokenMint,
          outputMint: input.tokenMint,
          sourceAmount: input.amount,
          owner: input.wallet.publicKey,
          slippageBps: input.swap.slippageBps,
          ...(maxAccounts === undefined ? {} : { maxAccounts }),
        })
      : undefined;
    if (swapLeg) {
      // Sized to the swap's guaranteed floor, never its quote: the deposit
      // instruction encodes a static amount and an ExactIn swap only promises
      // the threshold. Output above it stays in the wallet's token account.
      depositAmount = swapLeg.minOutAmount;
    }

    let plan: Awaited<ReturnType<typeof client.buildVaultDeposit>>;
    try {
      const built = await client.buildVaultDeposit(runtime, {
        providerReference: input.providerReference,
        owner: input.wallet.publicKey,
        amount: depositAmount,
        minSharesOut: input.minSharesOut,
        // The share ATA a first deposit creates is the reason a zero-SOL wallet
        // could not deposit even when its fees were sponsored.
        ...(rentPayer === undefined ? {} : { rentPayer }),
      });
      plan = appendVaultRequestMemo(
        swapLeg ? prependSwapLegToVaultPlan(built, swapLeg) : built,
        "vault-deposit",
        input.requestId
      );
    } catch (error) {
      getLogger().error({ error }, "vault deposit: build failed before signing");
      rethrowVaultProviderFailure(error);
    }

    if (plan.cluster !== cluster) {
      throw internalError(
        `Vault builder returned a ${plan.cluster} plan for the configured ${cluster} cluster`
      );
    }
    const accepted = requireAcceptedPlan(plan, { ...input, amount: depositAmount });

    // Swap-funded plans carry a LOCALLY derived compute-unit limit (see the
    // sizing note in jupiter-swap.service.ts): probe-simulate at the maximum,
    // then pin the buffered, capped consumption as the plan's first
    // instruction; the intent execution below re-simulates exactly that final
    // plan before signing. Wallet-pays is already forced above, so the probe
    // asks the same question signing will.
    if (swapLeg) {
      const probe = await simulateVaultPlan(env, {
        cluster,
        deadline,
        expectedAssetIdentity,
        plan: withComputeUnitLimit(plan, MAX_COMPUTE_UNIT_LIMIT),
        owner: address(input.wallet.publicKey),
        rpcUrl,
        fee,
      });
      if (!probe.ok) {
        getLogger().error(
          { error: probe.error, logs: probe.logs.slice(-5) },
          "vault deposit: compute-unit probe simulation failed"
        );
        throw badRequest(`Vault deposit simulation failed: ${probe.error}`);
      }
      plan = withComputeUnitLimit(plan, bufferedComputeUnitLimit(probe.unitsConsumed));
    }

    return executeSignedVaultIntent({
      operation: "deposit",
      env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      walletId: input.wallet.id,
      walletPublicKey: input.wallet.publicKey,
      signerMismatchMessage: "Resolved signing wallet does not match the deposit wallet",
      cluster,
      deadline,
      expectedAssetIdentity,
      plan,
      rpcUrl,
      fee,
      runIntentTransaction: options.runIntentTransaction,
      persist: (db, signed) =>
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
          // The DEPOSIT amount, in the deposit token — for a swap-funded build
          // the derived floor, never the source amount, because the row's
          // denomination is the deposit mint and a movement row is a claim
          // about what moved on chain.
          requestedAmount: depositAmount,
          acceptedMinSharesOut: accepted.minSharesOut,
          sourceAddress: input.wallet.publicKey,
          signature: signed.signature,
          signedTransaction: Buffer.from(signed.bytes).toString("base64"),
          lastValidBlockHeight: signed.lastValidBlockHeight,
          requestId: input.requestId,
          idempotencyFingerprint: fingerprint,
          createdBy: input.userId ?? null,
          initiatedByKeyId: input.apiKeyId ?? null,
          // Only the builder, which read the chain, knows whether this deposit
          // creates the share account and therefore pays its rent. Recording the
          // funder now is what lets the exit give it back to the right party,
          // possibly months later and under a different fee mode.
          createsShareAccount: plan.createsShareAccount === true,
          shareAtaRentFunder: rentPayer ?? null,
        }),
    });
  };

  if (!input.swap) {
    return attemptDeposit();
  }
  try {
    return await attemptDeposit();
  } catch (error) {
    if (!(error instanceof VaultTransactionTooLargeError)) throw error;
    // One re-route for compactness; the oversized attempt signed nothing
    // durable and broadcast nothing.
  }
  try {
    return await attemptDeposit(RETRY_SWAP_MAX_ACCOUNTS);
  } catch (error) {
    if (!(error instanceof VaultTransactionTooLargeError)) throw error;
    // Custody deposits have no split flow (a standalone swap would be an
    // unrecorded custody movement), so the honest answer is a refusal that
    // names the alternative.
    throw badRequest(
      "This swap-funded deposit cannot fit in one Solana transaction even on a compact route. " +
        "Deposit in the vault's own token, or convert the funds first and retry without " +
        "sourceTokenMint."
    );
  }
}
