import { notImplemented } from "@sdp/earn/errors";
import type { EarnRuntimeContext, EarnVaultTransactionPlan } from "@sdp/earn/types";
import type { SdpEnvironment } from "@sdp/types";
import type { EarnProviderId } from "@sdp/types/provider-access";
import {
  address,
  bytesEqual,
  getPublicKeyFromAddress,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type SignatureBytes,
  verifySignature,
} from "@solana/kit";
import { getDb } from "@/db";
import {
  createPostgresEarnExternalWalletTransactionsRepository,
  type EarnExternalWalletTransactionRow,
  generateEarnExternalWalletTransactionId,
} from "@/db/repositories/earn-external-wallet-transactions.repository";
import {
  assertMovementIsOwnReplay,
  createPostgresEarnMovementsRepository,
  type EarnMovementRow,
  type EarnPositionRow,
} from "@/db/repositories/earn-movements.repository";
import {
  createPostgresEarnSplitSwapAdvisoriesRepository,
  generateEarnSplitSwapAdvisoryId,
} from "@/db/repositories/earn-split-swap-advisories.repository";
import { badRequest, internalError, notFound, transactionExpired } from "@/lib/errors";
import {
  buildEarnExternalWalletDepositFingerprint,
  buildEarnExternalWalletWithdrawalFingerprint,
  resolveIdempotencyReplay,
} from "@/lib/idempotency";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";
import { assertVaultDepositEligible } from "./deposit-eligibility";
import {
  earnClusterFor,
  resolveClusterRpcUrl,
  resolveVaultDirectClient,
  resolveVaultWithdrawClient,
} from "./execution-registry";
import {
  bufferedComputeUnitLimit,
  fetchJupiterSwapLeg,
  type JupiterSwapLeg,
  MAX_COMPUTE_UNIT_LIMIT,
  prependSwapLegToVaultPlan,
  RETRY_SWAP_MAX_ACCOUNTS,
  requireWellKnownMintDecimals,
  withComputeUnitLimit,
} from "./jupiter-swap.service";
import { readOwnerMintBalance } from "./owner-token-balance";
import { createVaultDeadline } from "./vault-deadline";
import { requireAcceptedPlan } from "./vault-deposit.service";
import {
  appendVaultRequestMemo,
  compileUnsignedVaultTransaction,
  simulateVaultPlan,
  type UnsignedVaultTransaction,
  VaultTransactionTooLargeError,
} from "./vault-execution.service";
import { ledgerVaultExposureGate } from "./vault-exposure";
import {
  broadcastRecordedVaultMovement,
  isSlippageSimulationFailure,
  readConfirmedBlockHeight,
} from "./vault-intent-execution.service";
import { rethrowVaultProviderFailure } from "./vault-refusals";
import { rawSimulationDetails } from "./vault-simulation-error";
import { type VaultFeeMode, vaultRentPayer } from "./vault-sponsorship";
import { requireAcceptedWithdrawalPlan } from "./vault-withdraw.service";

/**
 * The external-wallet (caller-signed) vault flows: SDP moves money for a wallet it
 * does NOT custody (PRO-1722, ADR 0002 addendum 2026-08-26).
 *
 * Each direction starts with a BUILD that produces one complete unsigned
 * transaction: provider build, simulation with the resolved fee payer, memo
 * binding, and compile. An authenticated build is persisted so the keyed
 * SUBMIT can prove it received the exact bytes SDP built. An anonymous build
 * is ephemeral, writes no transaction, advisory, position, or movement row,
 * and must be broadcast and tracked by the caller. The keyed SUBMIT verifies
 * every returned signature, records the movement durably, and only then
 * broadcasts. Past that durable write, the custody and external-wallet flows
 * share one tail and one reconciler.
 *
 * NOTHING here signs, resolves a signer, or touches custody: the owner's
 * own signature is the authorization to move the owner's money, which is
 * why these paths take no wallet policy gate.
 */

interface ExternalWalletBuildTenantContext {
  organizationId: string;
  projectId: string;
  userId?: string | null;
  apiKeyId?: string | null;
}

interface AnonymousExternalWalletBuildContext {
  organizationId?: never;
  projectId?: never;
  userId?: never;
  apiKeyId?: never;
}

export type ExternalWalletBuildContext =
  | ExternalWalletBuildTenantContext
  | AnonymousExternalWalletBuildContext;

function hasExternalWalletBuildTenant(
  input: ExternalWalletBuildContext
): input is ExternalWalletBuildTenantContext {
  return input.organizationId !== undefined && input.projectId !== undefined;
}

/**
 * Fields the builder and wire adapter share across durable and ephemeral
 * builds. Database-only metadata stays on the repository row instead of
 * becoming optional throughout the service contract.
 */
export type ExternalWalletBuiltTransaction = Pick<
  EarnExternalWalletTransactionRow,
  | "id"
  | "environment"
  | "provider"
  | "direction"
  | "owner_address"
  | "vault_address"
  | "token_mint"
  | "share_mint"
  | "label"
  | "position_id"
  | "denomination"
  | "amount_requested"
  | "min_shares_out"
  | "creates_share_account"
  | "fee_payer"
  | "share_ata_rent_funder"
  | "unsigned_transaction"
  | "last_valid_block_height"
>;

export type ExternalWalletDepositBuildInput = ExternalWalletBuildContext & {
  environment: SdpEnvironment;
  provider: EarnProviderId;
  /** Catalogue row id, so a split-swap advisory can name the strategy (PRO-1864). */
  strategyId: string;
  /** Vault address — the strategy's providerReference. */
  providerReference: string;
  /** The external wallet that will sign and own the shares. */
  ownerAddress: string;
  /**
   * Optional partner fee payer: a caller-controlled wallet that pays the
   * network fee and — because the provider build charges account rent to the
   * same identity — the share-ATA rent a first deposit creates. The compiled
   * transaction requires its signature alongside the owner's; the partner
   * co-signs before submit. Absent, the owner pays everything. Already
   * normalized by the route: never equal to `ownerAddress`.
   */
  feePayer?: string;
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
  /** Slippage floor, decimal string. */
  minSharesOut?: string;
  /** Fund the deposit by swapping another stablecoin first (Jupiter). */
  swap?: {
    /** Validated by the route: a supported swap-source mint on this cluster. */
    sourceTokenMint: string;
    slippageBps: number;
  };
};

/**
 * Normalize a provider build failure, shared by both directions: a refused
 * amount is the CALLER's 400; anything else stays the provider's own error.
 */
function rethrowProviderBuildFailure(error: unknown, operation: string): never {
  getLogger().error({ error }, `${operation}: build failed`);
  rethrowVaultProviderFailure(error);
}

/**
 * Map a failed simulation verdict to HTTP, shared by every build simulation
 * on this surface: a caller fault (broke owner or fee payer, program refusal)
 * is a 400 the caller can act on, while a sponsor fault is SDP's own problem
 * (a plan that under-prefunded rent — see VaultSimulationVerdict.sponsorCause)
 * and surfaces as a 5xx so a client never treats it as a permanent request
 * error to stop retrying differently.
 */
function throwSimulationRefusal(
  prefix: string,
  simulation: {
    error: string;
    fault: "caller" | "sponsor";
    logs: readonly string[];
    /** The chain's raw `TransactionError` variant; travels in `details`, never in prose. */
    raw?: string;
  }
): never {
  const message = `${prefix}: ${simulation.error}`;
  if (simulation.fault === "sponsor") throw internalError(message);
  if (isSlippageSimulationFailure(simulation.error, simulation.logs)) {
    throw badRequest(
      `${prefix}: the vault would return less than the request's slippage floor allows. ` +
        "Raise the slippage tolerance (or lower the floor) and try again.",
      { reason: "slippage_exceeded" }
    );
  }
  // The message is what a customer reads in the modal; the variant the chain
  // answered with rides in `details` so an operator can still grep for it.
  throw badRequest(message, rawSimulationDetails(simulation.raw));
}

export type ExternalWalletDepositBuildResult =
  | {
      kind: "built";
      built: ExternalWalletBuiltTransaction;
      /** The swap leg composed into the transaction, when the build was swap-funded. */
      swap?: JupiterSwapLeg;
    }
  | {
      /**
       * The composed swap + deposit could not fit one Solana packet, even
       * after re-routing for compactness. No submit-capable build or movement
       * was persisted. A keyed build records only its recovery advisory; an
       * anonymous build writes no row. The caller gets an unsigned SWAP-ONLY
       * transaction to sign and broadcast itself, then requests an ordinary
       * unswapped build for `swap.minOutAmount`.
       */
      kind: "swap_required";
      swap: JupiterSwapLeg;
      swapTransaction: UnsignedVaultTransaction;
    };

type ExternalWalletDepositAttempt =
  | {
      fit: true;
      unsigned: UnsignedVaultTransaction;
      plan: EarnVaultTransactionPlan;
      depositAmount: string;
      minSharesOut: string | null;
      swapLeg?: JupiterSwapLeg;
    }
  | { fit: false; swapLeg: JupiterSwapLeg };

async function firstExternalWalletDepositAttempt(
  attemptBuild: (
    maxAccounts?: number,
    compactMemo?: boolean
  ) => Promise<ExternalWalletDepositAttempt>,
  swapFunded: boolean,
  fee: VaultFeeMode
): Promise<ExternalWalletDepositAttempt> {
  try {
    return await attemptBuild();
  } catch (error) {
    if (swapFunded || !(error instanceof VaultTransactionTooLargeError)) throw error;
  }

  try {
    return await attemptBuild(undefined, true);
  } catch (error) {
    if (!(error instanceof VaultTransactionTooLargeError)) throw error;
    throw badRequest(
      fee.kind === "caller-provided"
        ? "This vault deposit cannot fit in one Solana transaction with a separate fee payer. Retry without feePayer so the owner pays the network fee."
        : "This vault deposit cannot fit in one Solana transaction, even with a compact request binding."
    );
  }
}

export async function buildExternalWalletDepositTransaction(
  env: Env,
  input: ExternalWalletDepositBuildInput
): Promise<ExternalWalletDepositBuildResult> {
  const deadline = createVaultDeadline();
  const client = resolveVaultDirectClient(env, input.provider, deadline);
  if (!client) {
    throw notImplemented(input.provider, "direct vault deposits");
  }
  const cluster = earnClusterFor(input.environment);
  const rpcUrl = resolveClusterRpcUrl(env, cluster);
  // Minted BEFORE the build because the memo binds it into the instructions:
  // it is the transaction's on-chain identity, the way the custody flow binds
  // the caller's idempotency key. The submit's key cannot serve here — it does
  // not exist yet at build time.
  const transactionId = generateEarnExternalWalletTransactionId();
  const expectedAssetIdentity = {
    depositTokenMint: input.tokenMint,
    shareMint: input.shareMint,
  };
  const runtime: EarnRuntimeContext = { env, environment: input.environment };
  // A fee payer equal to the owner IS the default; normalized here (the route
  // does too) so no caller can store a fee payer the compiled transaction does
  // not actually require. One fee mode then drives the provider's rent payer,
  // the fee payer every simulation runs with, and the compiled fee-payer seat —
  // the same three-places-must-agree rule sponsorship follows
  // (vault-sponsorship.ts).
  const feePayer = input.feePayer === input.ownerAddress ? undefined : input.feePayer;
  if (!hasExternalWalletBuildTenant(input) && feePayer !== undefined) {
    throw badRequest("Anonymous external-wallet builds must use the owner as fee payer");
  }
  const fee: VaultFeeMode = feePayer
    ? { kind: "caller-provided", feePayer: address(feePayer) }
    : { kind: "wallet-pays" };
  const rentPayer = vaultRentPayer(fee);

  // Provider-side KYC/eligibility for the END-USER wallet, before the build.
  // This is the B2B2C path's whole point of failure for regulated funds: the
  // partner's user signs, but only an issuer-verified wallet can RECEIVE the
  // settlement. A refusal deliberately stays generic and non-enumerating;
  // wallet registration, approval and product entitlement must not be
  // distinguishable through this admission boundary.
  await assertVaultDepositEligible(client, runtime, {
    providerReference: input.providerReference,
    owner: input.ownerAddress,
  });

  /**
   * One build attempt at a given swap route width. Swap-funded builds may run
   * it twice: the composed transaction's size is only knowable after
   * lookup-table compression, and the honest response to an overflow is a
   * more compact route, which is a fresh Jupiter quote and therefore a fresh
   * provider plan (the guaranteed output moves with the route).
   */
  const attemptBuild = async (
    maxAccounts?: number,
    compactMemo = false
  ): Promise<ExternalWalletDepositAttempt> => {
    let swapLeg: JupiterSwapLeg | undefined;
    let depositAmount = input.amount;
    if (input.swap) {
      swapLeg = await fetchJupiterSwapLeg(env, deadline, {
        inputMint: input.swap.sourceTokenMint,
        outputMint: input.tokenMint,
        sourceAmount: input.amount,
        owner: input.ownerAddress,
        ...(fee.kind === "caller-provided" ? { payer: fee.feePayer } : {}),
        slippageBps: input.swap.slippageBps,
        ...(maxAccounts === undefined ? {} : { maxAccounts }),
      });
      // Sized to the swap's guaranteed floor, never its quote: the deposit
      // instruction encodes a static amount, and an ExactIn swap only promises
      // the threshold. Output above it stays in the owner's token account.
      depositAmount = swapLeg.minOutAmount;
    }

    let plan: EarnVaultTransactionPlan;
    try {
      const built = await client.buildVaultDeposit(runtime, {
        providerReference: input.providerReference,
        owner: input.ownerAddress,
        amount: depositAmount,
        minSharesOut: input.minSharesOut,
        // The partner fee payer funds account rent too, or nobody but the
        // owner does — the one-identity rule from vault-sponsorship.ts. This
        // is the CALLER's wallet co-signing, not Kora: SDP-side sponsorship
        // for caller-signed movements stays PRO-1744, a separate decision.
        ...(rentPayer === undefined ? {} : { rentPayer }),
      });
      plan = appendVaultRequestMemo(
        swapLeg ? prependSwapLegToVaultPlan(built, swapLeg) : built,
        "external-deposit",
        transactionId,
        { compact: compactMemo }
      );
    } catch (error) {
      rethrowProviderBuildFailure(error, "external-wallet deposit");
    }

    if (plan.cluster !== cluster) {
      throw internalError(
        `Vault builder returned a ${plan.cluster} plan for the configured ${cluster} cluster`
      );
    }
    const accepted = requireAcceptedPlan(plan, { ...input, amount: depositAmount });

    try {
      // Swap-funded plans carry a LOCALLY derived compute-unit limit (see the
      // sizing note in jupiter-swap.service.ts): probe-simulate at the maximum,
      // then pin the buffered, capped consumption as the plan's first
      // instruction. Without it, a high-CU route under the 1.4M ceiling would
      // die on Solana's per-instruction default budget despite being valid.
      if (swapLeg) {
        plan = await pinProbedComputeUnitLimit(env, {
          cluster,
          deadline,
          expectedAssetIdentity,
          plan,
          ownerAddress: input.ownerAddress,
          rpcUrl,
          fee,
          probeLabel: "external-wallet deposit: compute-unit probe simulation failed",
          refusalNoun: "Vault deposit",
        });
      }

      // Simulate with the resolved fee payer, using the exact shape that will be
      // signed. This is also the funds check: it asks the FEE PAYER's lamports
      // (the partner's wallet on a feePayer build). The zero-SOL owners this
      // exists for must not fail here) and the owner's tokens, surfacing both as
      // readable errors at build time, before anyone signs anything.
      // On a swap-funded build the swap leg executes inside this simulation, so
      // "the owner holds enough of the SOURCE token" is checked by the chain
      // itself rather than re-derived here.
      const simulation = await simulateVaultPlan(env, {
        cluster,
        deadline,
        expectedAssetIdentity,
        plan,
        owner: address(input.ownerAddress),
        rpcUrl,
        fee,
      });
      if (!simulation.ok) {
        getLogger().error(
          { error: simulation.error, raw: simulation.raw, logs: simulation.logs.slice(-5) },
          "external-wallet deposit: simulation failed"
        );
        throwSimulationRefusal("Vault deposit simulation failed", simulation);
      }

      const unsigned = compileUnsignedVaultTransaction({
        cluster,
        deadline,
        expectedAssetIdentity,
        plan,
        owner: address(input.ownerAddress),
        ...(fee.kind === "caller-provided" ? { feePayer: fee.feePayer } : {}),
        prepared: simulation.prepared,
      });
      return {
        fit: true,
        unsigned,
        plan,
        depositAmount,
        minSharesOut: accepted.minSharesOut,
        ...(swapLeg === undefined ? {} : { swapLeg }),
      };
    } catch (error) {
      // Size is measured before every RPC simulation as well as at the final
      // compile. Only a swap-funded plan has a legitimate next move on
      // overflow; an unswapped provider plan that cannot fit is the provider's
      // own defect and keeps failing loudly, exactly as before.
      if (swapLeg && error instanceof VaultTransactionTooLargeError) {
        return { fit: false, swapLeg };
      }
      throw error;
    }
  };

  let attempt = await firstExternalWalletDepositAttempt(
    attemptBuild,
    input.swap !== undefined,
    fee
  );
  if (!attempt.fit) {
    attempt = await attemptBuild(RETRY_SWAP_MAX_ACCOUNTS, true);
  }
  if (!attempt.fit) {
    // Split flow: the swap alone, compiled through the same simulate-and-size
    // seam, for the owner and any separate fee payer to sign before the owner
    // broadcasts it. It carries no request memo and records NO movement: it moves
    // the owner's own funds between the
    // owner's own accounts, and the follow-up deposit build takes the ordinary
    // path. A keyed build records an ADVISORY (PRO-1864, EARN-026): the
    // standalone swap is the one transaction this flow hands out that SDP never
    // sees again, so without a row a partner that broadcast it and crashed left
    // the customer's funds swapped-but-undeposited with nothing for a detector
    // to inspect. An anonymous build records nothing and leaves recovery to the
    // caller.
    const swapLeg = attempt.swapLeg;
    const sourceTokenMint = input.swap?.sourceTokenMint ?? input.tokenMint;
    const depositTokenDecimals = requireWellKnownMintDecimals(input.tokenMint, "deposit token");
    const hasTenant = hasExternalWalletBuildTenant(input);
    // Compile and read the keyed-only baseline concurrently, preserving the
    // partner's blockhash window. The baseline fails closed alongside the
    // advisory insert; an anonymous build skips the read entirely.
    const [swapTransaction, baseline] = await Promise.all([
      compileStandaloneSwapTransaction(env, {
        cluster,
        deadline,
        rpcUrl,
        ownerAddress: input.ownerAddress,
        sourceTokenMint,
        depositTokenMint: input.tokenMint,
        swapLeg,
        // The split swap is one of the transactions this flow hands out, so
        // the partner fee payer covers it too and co-signs before the owner
        // broadcasts it, exactly like the deposit it precedes.
        fee,
      }),
      hasTenant
        ? deadline.run("Reading the split-swap baseline balance", () =>
            readOwnerMintBalance(env, input.environment, input.ownerAddress, input.tokenMint)
          )
        : Promise.resolve(null),
    ]);
    if (!hasTenant) {
      return { kind: "swap_required", swap: swapLeg, swapTransaction };
    }
    if (baseline === null) throw internalError("Split-swap baseline balance is unavailable");
    if (baseline.decimals !== null && baseline.decimals !== depositTokenDecimals) {
      throw internalError(
        `Split-swap baseline balance reports ${baseline.decimals} decimals for a ${depositTokenDecimals}-decimal deposit token`
      );
    }
    await createPostgresEarnSplitSwapAdvisoriesRepository(getDb(env)).create({
      id: generateEarnSplitSwapAdvisoryId(),
      organizationId: input.organizationId,
      projectId: input.projectId,
      environment: input.environment,
      provider: input.provider,
      strategyId: input.strategyId,
      vaultAddress: input.providerReference,
      ownerAddress: input.ownerAddress,
      sourceTokenMint,
      depositTokenMint: input.tokenMint,
      depositTokenDecimals,
      swapSourceAmount: swapLeg.sourceAmount,
      swapMinOutAmount: swapLeg.minOutAmount,
      swapMinOutAtoms: swapLeg.minOutAtoms,
      swapLastValidBlockHeight: swapTransaction.lastValidBlockHeight,
      feePayer: feePayer ?? null,
      baselineDepositTokenAtoms: baseline.atoms.toString(),
      createdBy: input.userId ?? null,
      initiatedByKeyId: input.apiKeyId ?? null,
    });
    return { kind: "swap_required", swap: swapLeg, swapTransaction };
  }

  const { unsigned, plan, depositAmount, minSharesOut, swapLeg } = attempt;
  if (!hasExternalWalletBuildTenant(input)) {
    return {
      kind: "built",
      built: {
        id: transactionId,
        environment: input.environment,
        provider: input.provider,
        direction: "deposit",
        owner_address: input.ownerAddress,
        vault_address: input.providerReference,
        token_mint: input.tokenMint,
        share_mint: input.shareMint,
        label: input.label,
        position_id: null,
        denomination: input.tokenMint,
        amount_requested: depositAmount,
        min_shares_out: minSharesOut,
        creates_share_account: plan.createsShareAccount === true,
        fee_payer: feePayer ?? null,
        share_ata_rent_funder: null,
        unsigned_transaction: Buffer.from(unsigned.bytes).toString("base64"),
        last_valid_block_height: unsigned.lastValidBlockHeight,
      },
      ...(swapLeg === undefined ? {} : { swap: swapLeg }),
    };
  }
  const built = await createPostgresEarnExternalWalletTransactionsRepository(getDb(env)).create({
    id: transactionId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    environment: input.environment,
    provider: input.provider,
    direction: "deposit",
    ownerAddress: input.ownerAddress,
    vaultAddress: input.providerReference,
    tokenMint: input.tokenMint,
    shareMint: input.shareMint,
    label: input.label,
    denomination: input.tokenMint,
    // The DEPOSIT amount, in the deposit token — for a swap-funded build the
    // derived floor, never the source amount, because `denomination` above is
    // the deposit mint and a movement row is a claim about what moved.
    amountRequested: depositAmount,
    minSharesOut,
    createsShareAccount: plan.createsShareAccount === true,
    feePayer: feePayer ?? null,
    // The rent funder to carry onto the movement at submit: the fee payer when
    // the plan creates the share account (its address was embedded as the
    // provider's rentPayer), NULL otherwise — the owner paid, or nothing was
    // created. Recorded at build because the exit must refund whoever actually
    // paid, never whoever is configured when the exit happens.
    shareAtaRentFunder:
      plan.createsShareAccount === true && feePayer !== undefined ? feePayer : null,
    unsignedTransaction: Buffer.from(unsigned.bytes).toString("base64"),
    lastValidBlockHeight: unsigned.lastValidBlockHeight,
    createdBy: input.userId ?? null,
    initiatedByKeyId: input.apiKeyId ?? null,
  });
  return { kind: "built", built, ...(swapLeg === undefined ? {} : { swap: swapLeg }) };
}

/**
 * Probe-simulate a plan at the maximum compute-unit limit, then pin the
 * buffered observed consumption as its limit. Shared by the composed
 * swap-funded build and the standalone split swap — one copy of the sizing
 * rule, one copy of its refusal shape.
 */
async function pinProbedComputeUnitLimit(
  env: Env,
  input: {
    cluster: ReturnType<typeof earnClusterFor>;
    deadline: ReturnType<typeof createVaultDeadline>;
    expectedAssetIdentity: { depositTokenMint: string; shareMint: string };
    plan: EarnVaultTransactionPlan;
    ownerAddress: string;
    rpcUrl: string;
    fee: VaultFeeMode;
    probeLabel: string;
    refusalNoun: string;
  }
): Promise<EarnVaultTransactionPlan> {
  const probe = await simulateVaultPlan(env, {
    cluster: input.cluster,
    deadline: input.deadline,
    expectedAssetIdentity: input.expectedAssetIdentity,
    plan: withComputeUnitLimit(input.plan, MAX_COMPUTE_UNIT_LIMIT),
    owner: address(input.ownerAddress),
    rpcUrl: input.rpcUrl,
    fee: input.fee,
  });
  if (!probe.ok) {
    getLogger().error(
      { error: probe.error, raw: probe.raw, logs: probe.logs.slice(-5) },
      input.probeLabel
    );
    throwSimulationRefusal(`${input.refusalNoun} simulation failed`, probe);
  }
  return withComputeUnitLimit(input.plan, bufferedComputeUnitLimit(probe.unitsConsumed));
}

/**
 * Compile the swap leg alone as one unsigned owner-signed transaction, for the
 * split flow. It rides the same simulate-then-compile seam as every vault
 * transaction with the same resolved fee-payer funds check and size assertion,
 * with an asset identity that states the swap's own mints (source in, deposit
 * token out) since there is no vault leg to testify to.
 */
async function compileStandaloneSwapTransaction(
  env: Env,
  input: {
    cluster: ReturnType<typeof earnClusterFor>;
    deadline: ReturnType<typeof createVaultDeadline>;
    rpcUrl: string;
    ownerAddress: string;
    sourceTokenMint: string;
    depositTokenMint: string;
    swapLeg: JupiterSwapLeg;
    /** The build's resolved fee mode — the split swap keeps the same payer. */
    fee: VaultFeeMode;
  }
): Promise<UnsignedVaultTransaction> {
  const assetIdentity = {
    depositTokenMint: input.sourceTokenMint,
    shareMint: input.depositTokenMint,
  };
  const bare: EarnVaultTransactionPlan = {
    cluster: input.cluster,
    instructions: input.swapLeg.instructions,
    lookupTables: input.swapLeg.lookupTableAddresses,
    assetIdentity,
  };
  // Same locally derived compute-unit limit as the composed path: probe at
  // the maximum, then pin the buffered consumption.
  const plan = await pinProbedComputeUnitLimit(env, {
    cluster: input.cluster,
    deadline: input.deadline,
    expectedAssetIdentity: assetIdentity,
    plan: bare,
    ownerAddress: input.ownerAddress,
    rpcUrl: input.rpcUrl,
    fee: input.fee,
    probeLabel: "external-wallet deposit: standalone swap probe simulation failed",
    refusalNoun: "Swap",
  });
  const simulation = await simulateVaultPlan(env, {
    cluster: input.cluster,
    deadline: input.deadline,
    expectedAssetIdentity: assetIdentity,
    plan,
    owner: address(input.ownerAddress),
    rpcUrl: input.rpcUrl,
    fee: input.fee,
  });
  if (!simulation.ok) {
    getLogger().error(
      { error: simulation.error, raw: simulation.raw, logs: simulation.logs.slice(-5) },
      "external-wallet deposit: standalone swap simulation failed"
    );
    throwSimulationRefusal("Swap simulation failed", simulation);
  }
  return compileUnsignedVaultTransaction({
    cluster: input.cluster,
    deadline: input.deadline,
    expectedAssetIdentity: assetIdentity,
    plan,
    owner: address(input.ownerAddress),
    ...(input.fee.kind === "caller-provided" ? { feePayer: input.fee.feePayer } : {}),
    prepared: simulation.prepared,
  });
}

export type ExternalWalletWithdrawalBuildInput = ExternalWalletBuildContext & {
  environment: SdpEnvironment;
  provider: string;
  /** The EXISTING external-wallet holding being exited. */
  positionId: string | null;
  vaultAddress: string;
  tokenMint: string;
  shareMint: string;
  ownerAddress: string;
  /**
   * Optional partner fee payer, same contract as the deposit build: pays the
   * fee and any rent an exit consolidation creates, co-signs before submit.
   * Never equal to `ownerAddress` (route-normalized).
   */
  feePayer?: string;
  label: string;
  /** Recorded rent attribution from the position row; null means the owner. */
  shareAtaRentFunder: string | null;
  /** Decimal string in share units. */
  shares: string;
  /** Minimum deposit-token amount the exit may return. */
  minAmountOut?: string;
};

export async function buildExternalWalletWithdrawalTransaction(
  env: Env,
  input: ExternalWalletWithdrawalBuildInput
): Promise<ExternalWalletBuiltTransaction> {
  const deadline = createVaultDeadline();
  // Capability is the ONLY provider-shaped refusal on this path (ADR 0002 exit
  // safety): no surfacing, no entitlement, no availability, no catalogue.
  const client = resolveVaultWithdrawClient(env, input.provider, deadline);
  if (!client) {
    throw notImplemented(input.provider, "vault withdrawals");
  }
  const cluster = earnClusterFor(input.environment);
  const rpcUrl = resolveClusterRpcUrl(env, cluster);
  const transactionId = generateEarnExternalWalletTransactionId();
  const expectedAssetIdentity = {
    depositTokenMint: input.tokenMint,
    shareMint: input.shareMint,
  };
  const runtime: EarnRuntimeContext = { env, environment: input.environment };

  // The recorded rent funder (NULL means the owner paid its own rent) drives
  // the refund, for the same reason the custody exit reads it from the
  // position: refund whoever actually paid, never whoever is configured today.
  // A partner-funded position therefore refunds the PARTNER on exit.
  const rentRefundTo = input.shareAtaRentFunder ?? undefined;
  // Same one-value rule (and owner normalization) as the deposit build: the
  // fee mode drives the provider's rent payer (an exit consolidation can
  // create an account), the simulation fee payer, and the compiled seat.
  const feePayer = input.feePayer === input.ownerAddress ? undefined : input.feePayer;
  if (!hasExternalWalletBuildTenant(input) && feePayer !== undefined) {
    throw badRequest("Anonymous external-wallet builds must use the owner as fee payer");
  }
  const fee: VaultFeeMode = feePayer
    ? { kind: "caller-provided", feePayer: address(feePayer) }
    : { kind: "wallet-pays" };
  const rentPayer = vaultRentPayer(fee);

  const buildPlan = async (compactMemo = false): Promise<EarnVaultTransactionPlan> => {
    try {
      const built = await client.buildVaultWithdrawal(runtime, {
        providerReference: input.vaultAddress,
        owner: input.ownerAddress,
        shares: input.shares,
        ...(input.minAmountOut === undefined ? {} : { minAmountOut: input.minAmountOut }),
        ...(rentPayer === undefined ? {} : { rentPayer }),
        ...(rentRefundTo === undefined ? {} : { rentRefundTo }),
      });
      return appendVaultRequestMemo(built, "external-withdrawal", transactionId, {
        compact: compactMemo,
      });
    } catch (error) {
      rethrowProviderBuildFailure(error, "external-wallet withdrawal");
    }
  };

  let plan = await buildPlan();

  if (plan.cluster !== cluster) {
    throw internalError(
      `Vault builder returned a ${plan.cluster} plan for the configured ${cluster} cluster`
    );
  }
  // A floor the plan does not encode protects nothing on chain (Kamino's
  // kvault withdraw takes only a share amount). The custody exit treats the
  // same gap as an invariant breach; here the caller chose the floor, so it
  // is the caller's 400. A floor the plan echoes differently stays the
  // shared internal check below.
  if (input.minAmountOut !== undefined && plan.accepted?.minAmountOut === undefined) {
    throw badRequest(
      `minAmountOut is not supported for ${input.provider} exits: the vault's withdraw ` +
        "instruction takes only a share amount, so no floor can be enforced on chain. " +
        "Omit minAmountOut; withdrawalSlippage is null for this strategy."
    );
  }
  requireAcceptedWithdrawalPlan(plan, input);

  const simulateAndCompile = async () => {
    const simulation = await simulateVaultPlan(env, {
      cluster,
      deadline,
      expectedAssetIdentity,
      plan,
      owner: address(input.ownerAddress),
      rpcUrl,
      fee,
    });
    if (!simulation.ok) {
      getLogger().error(
        { error: simulation.error, raw: simulation.raw, logs: simulation.logs.slice(-5) },
        "external-wallet withdrawal: simulation failed"
      );
      throwSimulationRefusal("Vault withdrawal simulation failed", simulation);
    }

    return compileUnsignedVaultTransaction({
      cluster,
      deadline,
      expectedAssetIdentity,
      plan,
      owner: address(input.ownerAddress),
      ...(fee.kind === "caller-provided" ? { feePayer: fee.feePayer } : {}),
      prepared: simulation.prepared,
    });
  };

  let unsigned: UnsignedVaultTransaction;
  try {
    unsigned = await simulateAndCompile();
  } catch (error) {
    if (!(error instanceof VaultTransactionTooLargeError)) {
      throw error;
    }
    plan = await buildPlan(true);
    requireAcceptedWithdrawalPlan(plan, input);
    try {
      unsigned = await simulateAndCompile();
    } catch (compactError) {
      if (!(compactError instanceof VaultTransactionTooLargeError)) throw compactError;
      throw badRequest(
        fee.kind === "caller-provided"
          ? "This vault withdrawal cannot fit in one Solana transaction with a separate fee payer. Retry without feePayer so the owner can always exit."
          : "This vault withdrawal cannot fit in one Solana transaction, even with a compact request binding."
      );
    }
  }

  if (!hasExternalWalletBuildTenant(input)) {
    return {
      id: transactionId,
      environment: input.environment,
      provider: input.provider,
      direction: "withdrawal",
      owner_address: input.ownerAddress,
      vault_address: input.vaultAddress,
      token_mint: input.tokenMint,
      share_mint: input.shareMint,
      label: input.label,
      position_id: input.positionId,
      denomination: input.shareMint,
      amount_requested: input.shares,
      min_shares_out: input.minAmountOut ?? null,
      creates_share_account: plan.createsShareAccount === true,
      fee_payer: feePayer ?? null,
      share_ata_rent_funder: null,
      unsigned_transaction: Buffer.from(unsigned.bytes).toString("base64"),
      last_valid_block_height: unsigned.lastValidBlockHeight,
    };
  }

  return createPostgresEarnExternalWalletTransactionsRepository(getDb(env)).create({
    id: transactionId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    environment: input.environment,
    provider: input.provider,
    direction: "withdrawal",
    ownerAddress: input.ownerAddress,
    vaultAddress: input.vaultAddress,
    tokenMint: input.tokenMint,
    shareMint: input.shareMint,
    label: input.label,
    positionId: input.positionId,
    // Share units: the exact quantity the transaction encodes is shares, the
    // same denomination rule the custody exit follows.
    denomination: input.shareMint,
    amountRequested: input.shares,
    // The build table predates withdrawal floors and names its shared
    // protection column `min_shares_out`; direction disambiguates the unit.
    minSharesOut: input.minAmountOut ?? null,
    createsShareAccount: plan.createsShareAccount === true,
    feePayer: feePayer ?? null,
    // Same recording rule as the deposit build: an exit consolidation that
    // creates an account was rent-funded by the fee payer when one was named.
    shareAtaRentFunder:
      plan.createsShareAccount === true && feePayer !== undefined ? feePayer : null,
    unsignedTransaction: Buffer.from(unsigned.bytes).toString("base64"),
    lastValidBlockHeight: unsigned.lastValidBlockHeight,
    createdBy: input.userId ?? null,
    initiatedByKeyId: input.apiKeyId ?? null,
  });
}

export interface ExternalWalletSubmitInput {
  organizationId: string;
  projectId: string;
  environment: SdpEnvironment;
  /** The built transaction being submitted. */
  transactionId: string;
  /** Base64 wire bytes of the SIGNED transaction. */
  signedTransaction: string;
  /** Caller idempotency key. */
  requestId: string;
  userId?: string | null;
  apiKeyId?: string | null;
}

export interface ExternalWalletSubmitResult {
  position: EarnPositionRow;
  movement: EarnMovementRow;
  /** True when an existing recorded movement won; nothing was re-sent. */
  replayed: boolean;
}

export async function submitExternalWalletDeposit(
  env: Env,
  input: ExternalWalletSubmitInput
): Promise<ExternalWalletSubmitResult> {
  const built = await requireSubmittableBuiltTransaction(env, input, "deposit");
  const fingerprint = buildEarnExternalWalletDepositFingerprint({
    environment: input.environment,
    provider: built.provider,
    providerReference: built.vault_address,
    ownerAddress: built.owner_address,
    amount: built.amount_requested,
    minSharesOut: built.min_shares_out,
    transactionId: built.id,
  });

  const ledger = createPostgresEarnMovementsRepository(getDb(env));
  // Fast sequential replay path: a durable read that must keep answering
  // during an RPC outage, and must never touch a chain client. The atomic
  // insert below repeats the check under the built-transaction row lock.
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
    return replayedSubmitResult(ledger, input, prior);
  }

  await refuseExpiredBuild(env, input, built);
  const signed = await verifySignedExternalWalletTransaction(built, input.signedTransaction);

  const result = await ledger.createSignedExternalWalletDepositIntent({
    organizationId: input.organizationId,
    projectId: input.projectId,
    environment: input.environment,
    provider: built.provider,
    vaultAddress: built.vault_address,
    ownerAddress: built.owner_address,
    shareMint: built.share_mint,
    tokenMint: built.token_mint,
    label: built.label,
    requestedAmount: built.amount_requested,
    acceptedMinSharesOut: built.min_shares_out,
    // ADR 0004 layer 1, the write-side half (see the custody deposit): the
    // build's admission gate could not see a deposit admitted a moment
    // earlier, so the cap is decided again here under a per-vault lock. The
    // customer has signed; nothing has been sent. A refusal is the typed 409
    // and records nothing, which is the ADR's direction over landing a
    // deposit past the cap.
    admit: ledgerVaultExposureGate(env, {
      environment: input.environment,
      provider: built.provider,
      vaultAddress: built.vault_address,
      amount: built.amount_requested,
    }),
    signature: signed.signature,
    signedTransaction: signed.signedTransactionBase64,
    lastValidBlockHeight: built.last_valid_block_height,
    requestId: input.requestId,
    idempotencyFingerprint: fingerprint,
    externalWalletTransactionId: built.id,
    createsShareAccount: built.creates_share_account,
    // Rent attribution recorded at build time: the partner fee payer when it
    // funded the share ATA, NULL when the owner did. The exit refunds this.
    shareAtaRentFunder: built.share_ata_rent_funder,
    createdBy: input.userId ?? null,
    initiatedByKeyId: input.apiKeyId ?? null,
  });
  if (result.replayed) return result;

  return broadcastSubmitResult(env, input, result, signed, "external-wallet deposit");
}

export async function submitExternalWalletWithdrawal(
  env: Env,
  input: ExternalWalletSubmitInput
): Promise<ExternalWalletSubmitResult> {
  const built = await requireSubmittableBuiltTransaction(env, input, "withdrawal");
  if (!built.position_id) {
    throw internalError(`Earn external-wallet withdrawal build ${built.id} names no position`);
  }
  const fingerprint = buildEarnExternalWalletWithdrawalFingerprint({
    environment: input.environment,
    provider: built.provider,
    positionId: built.position_id,
    ownerAddress: built.owner_address,
    shares: built.amount_requested,
    transactionId: built.id,
  });

  const ledger = createPostgresEarnMovementsRepository(getDb(env));
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
    return replayedSubmitResult(ledger, input, prior);
  }

  await refuseExpiredBuild(env, input, built);
  const signed = await verifySignedExternalWalletTransaction(built, input.signedTransaction);

  const result = await ledger.createSignedExternalWalletWithdrawalIntent({
    organizationId: input.organizationId,
    projectId: input.projectId,
    environment: input.environment,
    provider: built.provider,
    positionId: built.position_id,
    vaultAddress: built.vault_address,
    ownerAddress: built.owner_address,
    shareMint: built.share_mint,
    requestedShares: built.amount_requested,
    signature: signed.signature,
    signedTransaction: signed.signedTransactionBase64,
    lastValidBlockHeight: built.last_valid_block_height,
    requestId: input.requestId,
    idempotencyFingerprint: fingerprint,
    externalWalletTransactionId: built.id,
    createsShareAccount: built.creates_share_account,
    shareAtaRentFunder: built.share_ata_rent_funder,
    createdBy: input.userId ?? null,
    initiatedByKeyId: input.apiKeyId ?? null,
  });
  if (result.replayed) return result;

  return broadcastSubmitResult(env, input, result, signed, "external-wallet withdrawal");
}

/**
 * Resolve the built transaction a submit names, with every scoping rule
 * answering 404: organization (in the query), exact project, environment, and
 * direction. A caller who may not submit a build must not learn it exists.
 */
async function requireSubmittableBuiltTransaction(
  env: Env,
  input: ExternalWalletSubmitInput,
  direction: "deposit" | "withdrawal"
): Promise<EarnExternalWalletTransactionRow> {
  const built = await createPostgresEarnExternalWalletTransactionsRepository(getDb(env)).getById({
    organizationId: input.organizationId,
    transactionId: input.transactionId,
  });
  if (
    !built ||
    built.environment !== input.environment ||
    // Exact match: a null project_id means the project was deleted, and a
    // deleted project's builds are unaddressable, not shared.
    built.project_id !== input.projectId ||
    built.direction !== direction
  ) {
    throw notFound("Earn external-wallet transaction");
  }
  return built;
}

const EXPIRED_BUILD_MESSAGE =
  "This transaction's blockhash expired before it was submitted. " +
  "Build a new transaction and have the customer sign it again.";

/**
 * Refuse an expired build BEFORE anything is recorded. Past
 * `last_valid_block_height` the signed bytes cannot land, so recording them
 * would only manufacture a `failed` row for the reconciler to expire and a
 * `requested` answer the caller has to poll to learn that. Ordered after the
 * replay short-circuit (a replay answers from the ledger, never from a chain
 * read) and skipped for a consumed build (its second key answers the
 * consumption conflict, which names the movement). A failed height read
 * does not refuse: the broadcast and the reconciler stay the safety net.
 */
async function refuseExpiredBuild(
  env: Env,
  input: ExternalWalletSubmitInput,
  built: EarnExternalWalletTransactionRow
): Promise<void> {
  if (built.movement_id !== null) return;
  let currentBlockHeight: bigint;
  try {
    const rpcUrl = resolveClusterRpcUrl(env, earnClusterFor(input.environment));
    currentBlockHeight = await readConfirmedBlockHeight(env, rpcUrl);
  } catch (error) {
    getLogger().warn(
      { transactionId: built.id, error },
      "external-wallet submit: block height unreadable; expiry left to the broadcast and reconciler"
    );
    return;
  }
  if (currentBlockHeight > BigInt(built.last_valid_block_height)) {
    throw transactionExpired(EXPIRED_BUILD_MESSAGE);
  }
}

async function replayedSubmitResult(
  ledger: ReturnType<typeof createPostgresEarnMovementsRepository>,
  input: ExternalWalletSubmitInput,
  movement: EarnMovementRow
): Promise<ExternalWalletSubmitResult> {
  const position = await ledger.getPositionById({
    organizationId: input.organizationId,
    environment: input.environment,
    positionId: movement.position_id,
  });
  if (!position || !movement.signature) {
    throw internalError(`Replayed movement ${movement.id} references missing execution details`);
  }
  return { position, movement, replayed: true };
}

async function broadcastSubmitResult(
  env: Env,
  input: ExternalWalletSubmitInput,
  result: ExternalWalletSubmitResult,
  signed: VerifiedSignedExternalWalletTransaction,
  operation: string
): Promise<ExternalWalletSubmitResult> {
  const cluster = earnClusterFor(input.environment);
  const rpcUrl = resolveClusterRpcUrl(env, cluster);
  const movement = await broadcastRecordedVaultMovement(env, {
    operation,
    organizationId: input.organizationId,
    cluster,
    deadline: createVaultDeadline(),
    rpcUrl,
    bytes: signed.bytes,
    signature: signed.signature,
    movement: result.movement,
  });
  return { ...result, movement };
}

export interface VerifiedSignedExternalWalletTransaction {
  bytes: Uint8Array;
  signature: string;
  /** Canonical re-encoding of the verified bytes, for the ledger outbox. */
  signedTransactionBase64: string;
}

/**
 * Prove the submitted bytes are the transaction SDP built, with only
 * signatures added, and that EVERY signature on it is genuine.
 *
 * MESSAGE equality is the check that matters, for the same reason the
 * sponsored custody path compares messages after the paymaster round trip:
 * nothing about "it decodes" or "a signature is present" constrains the bytes
 * to the fee payer, blockhash, and instruction list SDP simulated and
 * gate-checked. It is also what pins a build-time `feePayer`: the fee payer
 * lives in the message bytes, so it can never be swapped at submit. The
 * ed25519 verification then keeps garbage out of the ledger — the owner's AND
 * the fee payer's: without it an invalid signature would be recorded as a
 * durable movement that parks reconcilable until its blockhash expires,
 * failing a customer minutes later for something knowable now.
 */
export async function verifySignedExternalWalletTransaction(
  built: Pick<
    EarnExternalWalletTransactionRow,
    "id" | "owner_address" | "fee_payer" | "unsigned_transaction"
  >,
  signedTransactionBase64: string
): Promise<VerifiedSignedExternalWalletTransaction> {
  let signedBytes: Uint8Array;
  let decoded: ReturnType<ReturnType<typeof getTransactionDecoder>["decode"]>;
  try {
    signedBytes = Uint8Array.from(Buffer.from(signedTransactionBase64, "base64"));
    decoded = getTransactionDecoder().decode(signedBytes);
  } catch {
    throw badRequest("signedTransaction is not a decodable Solana transaction");
  }

  const unsigned = getTransactionDecoder().decode(
    Uint8Array.from(Buffer.from(built.unsigned_transaction, "base64"))
  );
  if (!bytesEqual(decoded.messageBytes, unsigned.messageBytes)) {
    throw badRequest(
      "signedTransaction does not match the built transaction; sign the exact bytes SDP returned"
    );
  }

  const ownerAddress = address(built.owner_address);
  if (decoded.signatures[ownerAddress] === undefined) {
    throw internalError(
      `Earn external-wallet build ${built.id} does not require its owner to sign`
    );
  }
  for (const [signerAddress, signature] of Object.entries(decoded.signatures)) {
    const slotNoun =
      signerAddress === ownerAddress
        ? "owner"
        : signerAddress === built.fee_payer
          ? "fee-payer"
          : `${signerAddress}`;
    if (signature == null) {
      throw badRequest(
        signerAddress === built.fee_payer
          ? "signedTransaction is missing the fee-payer signature; the fee payer co-signs before submit"
          : `signedTransaction is missing the ${slotNoun} signature`
      );
    }
    // Sequential on purpose: at most two slots, and each failure names its
    // slot so a partner can tell its own co-signing bug from the customer's.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- bounded two-signer loop.
    const signerKey = await getPublicKeyFromAddress(address(signerAddress));
    const validSignature = await verifySignature(
      signerKey,
      signature as SignatureBytes,
      decoded.messageBytes
    );
    if (!validSignature) {
      throw badRequest(`signedTransaction carries an invalid ${slotNoun} signature`);
    }
  }

  return {
    bytes: signedBytes,
    // Slot zero: the fee payer's signature when a partner fee payer is set,
    // the owner's otherwise — either way the transaction's on-chain id.
    signature: getSignatureFromTransaction(decoded),
    // Canonicalized: Buffer's base64 decoder is lenient, so the stored outbox
    // value is re-encoded from the verified bytes rather than trusted verbatim.
    signedTransactionBase64: Buffer.from(signedBytes).toString("base64"),
  };
}
