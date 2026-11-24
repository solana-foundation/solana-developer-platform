import { supportsProviderRedemptionModes, supportsVaultDepositQuote } from "@sdp/earn/capabilities";
import { notImplemented } from "@sdp/earn/errors";
import type { EarnVaultDepositQuote, EarnVaultTransactionPlan } from "@sdp/earn/types";
import { currentClusterScope } from "@sdp/rpc/scope";
import type { EarnProviderId } from "@sdp/types/provider-access";
import { earnDepositSlippagePolicy } from "@sdp/types/provider-access";
import {
  address,
  bytesEqual,
  getPublicKeyFromAddress,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type SignatureBytes,
  verifySignature,
} from "@solana/kit";
import { getDb } from "@/db/client";
import {
  createPostgresEarnWalletTransactionsRepository,
  type EarnWalletTransactionRow,
  generateEarnWalletTransactionId,
} from "@/db/repositories/earn-wallet-transactions.repository";
import { badRequest, internalError } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";
import { assertVaultDepositEligible } from "./deposit-eligibility";
import { resolveVaultDirectClient, resolveVaultWithdrawClient } from "./execution-registry";
import {
  bufferedComputeUnitLimit,
  fetchJupiterSwapLeg,
  type JupiterSwapLeg,
  MAX_COMPUTE_UNIT_LIMIT,
  prependSwapLegToVaultPlan,
  RETRY_SWAP_MAX_ACCOUNTS,
  withComputeUnitLimit,
} from "./jupiter-swap.service";
import { earnRuntime } from "./runtime";
import { requireAcceptedPlan, requireAcceptedWithdrawalPlan } from "./strategy-plan";
import { strategyOutputFloor } from "./strategy-terms";
import { createVaultDeadline } from "./vault-deadline";
import {
  appendVaultRequestMemo,
  compileUnsignedVaultTransaction,
  simulateVaultPlan,
  type UnsignedVaultTransaction,
  VaultTransactionTooLargeError,
} from "./vault-execution.service";
import { isSlippageSimulationFailure } from "./vault-intent-execution.service";
import { rethrowVaultProviderFailure } from "./vault-refusals";
import { rawSimulationDetails } from "./vault-simulation-error";
import { type VaultFeeMode, vaultRentPayer } from "./vault-sponsorship";

async function quotePreparedStrategyDeposit(
  client: NonNullable<ReturnType<typeof resolveVaultDirectClient>>,
  runtime: ReturnType<typeof earnRuntime>,
  input: WalletDepositBuildInput,
  amount: string
): Promise<{ quote?: EarnVaultDepositQuote; minSharesOut?: string }> {
  if (input.slippageBps === undefined) return { minSharesOut: input.minSharesOut };
  const { environment, cluster } = currentClusterScope();
  const policy = earnDepositSlippagePolicy(input.provider, environment, cluster);
  if (!supportsVaultDepositQuote(client)) {
    if (policy !== null) throw notImplemented(input.provider, "protected strategy deposit quotes");
    return { minSharesOut: input.minSharesOut };
  }
  const quote = await client.quoteVaultDeposit(runtime, {
    providerReference: input.providerReference,
    amount,
  });
  if (quote.blockingIssues.length > 0) {
    throw badRequest(quote.blockingIssues.map((issue) => issue.message).join("; "));
  }
  return {
    quote,
    minSharesOut:
      policy === null
        ? input.minSharesOut
        : strategyOutputFloor(quote.sharesOut, quote.shareDecimals, input.slippageBps),
  };
}

/**
 * Shared wallet transaction preparation for direct owner signatures and the
 * configured custody signer chosen by an operation's immutable source.
 *
 * Each direction starts with a BUILD that produces one complete unsigned
 * transaction: provider build, simulation with the resolved fee payer, memo
 * binding, and compile. Every build is persisted so the operation worker can
 * verify every signature over those exact bytes, record the movement durably,
 * and only then broadcast. This module never signs or sends.
 */

export interface WalletBuildContext {
  organizationId: string;
  projectId: string;
  userId?: string | null;
  apiKeyId?: string | null;
  /** Present only for preparation through the shared custody execution path. */
  custodyWalletId?: string;
  /** Trusted fee mode resolved through the shared sponsorship boundary. */
  fee?: VaultFeeMode;
}

/** Custody and owner-signed strategy plans share one fee and rent decision. */
function preparedStrategyFee(
  context: WalletBuildContext,
  feePayer: string | undefined
): VaultFeeMode {
  if (context.fee !== undefined) {
    if (context.custodyWalletId === undefined) {
      throw internalError("Custody fee mode requires a custody wallet");
    }
    if (feePayer !== undefined) {
      throw badRequest("A custody strategy operation cannot override its fee payer");
    }
    return context.fee;
  }
  return feePayer === undefined
    ? { kind: "wallet-pays" }
    : { kind: "caller-provided", feePayer: address(feePayer) };
}

function preparedFeePayer(fee: VaultFeeMode): ReturnType<typeof address> | undefined {
  const payer = vaultRentPayer(fee);
  return payer === undefined ? undefined : address(payer);
}

function storedFeeMode(fee: VaultFeeMode): "wallet" | "partner" | "sponsored" {
  switch (fee.kind) {
    case "wallet-pays":
      return "wallet";
    case "caller-provided":
      return "partner";
    case "sponsored":
      return "sponsored";
  }
}

/**
 * Fields the builder and wire adapter share. Database-only metadata stays on
 * the repository row instead of becoming part of the service contract.
 */
export type WalletBuiltTransaction = Pick<
  EarnWalletTransactionRow,
  | "id"
  | "environment"
  | "provider"
  | "strategy_id"
  | "custody_wallet_id"
  | "fee_mode"
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

/** A wallet deposit build. The open cluster scope decides its environment and cluster. */
export type WalletDepositBuildInput = WalletBuildContext & {
  provider: EarnProviderId;
  /** Catalogue strategy selected for the deposit. */
  strategyId: string;
  /** Vault address — the strategy's providerReference. */
  providerReference: string;
  /** The wallet that will sign and own the shares. */
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
  /** Core strategy preparations derive the floor from one live quote after swap sizing. */
  slippageBps?: number;
  /** Swap another stablecoin into the deposit token in the same transaction. */
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

/** Every successful preparation contains the complete atomic deposit transaction. */
export interface WalletDepositBuildResult {
  kind: "built";
  built: WalletBuiltTransaction;
  /** The swap leg composed into the transaction, when the build was swap-funded. */
  swap?: JupiterSwapLeg;
  quote?: EarnVaultDepositQuote;
}

type WalletDepositAttempt =
  | {
      fit: true;
      unsigned: UnsignedVaultTransaction;
      plan: EarnVaultTransactionPlan;
      depositAmount: string;
      minSharesOut: string | null;
      swapLeg?: JupiterSwapLeg;
      quote?: EarnVaultDepositQuote;
    }
  | { fit: false };

async function firstWalletDepositAttempt(
  attemptBuild: (maxAccounts?: number, compactMemo?: boolean) => Promise<WalletDepositAttempt>,
  swapFunded: boolean,
  fee: VaultFeeMode
): Promise<WalletDepositAttempt> {
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

export async function buildWalletDepositTransaction(
  env: Env,
  input: WalletDepositBuildInput
): Promise<WalletDepositBuildResult> {
  const deadline = createVaultDeadline();
  const client = resolveVaultDirectClient(env, input.provider, deadline);
  if (!client) {
    throw notImplemented(input.provider, "direct vault deposits");
  }
  const { environment, cluster } = currentClusterScope();
  // Minted BEFORE the build because the memo binds it into the instructions:
  // it is the transaction's on-chain identity, the way the custody flow binds
  // the caller's idempotency key. The submit's key cannot serve here — it does
  // not exist yet at build time.
  const transactionId = generateEarnWalletTransactionId();
  const expectedAssetIdentity = {
    depositTokenMint: input.tokenMint,
    shareMint: input.shareMint,
  };
  const runtime = earnRuntime(env);
  // A fee payer equal to the owner IS the default; normalized here (the route
  // does too) so no caller can store a fee payer the compiled transaction does
  // not actually require. One fee mode then drives the provider's rent payer,
  // the fee payer every simulation runs with, and the compiled fee-payer seat —
  // the same three-places-must-agree rule sponsorship follows
  // (vault-sponsorship.ts).
  const feePayer = input.feePayer === input.ownerAddress ? undefined : input.feePayer;
  const fee = preparedStrategyFee(input, feePayer);
  const rentPayer = vaultRentPayer(fee);

  // Provider-side KYC/eligibility for the END-USER wallet, before the build.
  // This is the B2B2C path's whole point of failure for regulated funds: the
  // partner's user signs, but only an issuer-verified wallet can RECEIVE the
  // settlement. A refusal deliberately stays generic and non-enumerating;
  // wallet registration, approval and product entitlement must not be
  // distinguishable through this admission boundary.
  await assertVaultDepositEligible(
    client,
    runtime,
    {
      providerReference: input.providerReference,
      owner: input.ownerAddress,
    },
    { organizationId: input.organizationId, projectId: input.projectId, database: env }
  );

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
  ): Promise<WalletDepositAttempt> => {
    let swapLeg: JupiterSwapLeg | undefined;
    let depositAmount = input.amount;
    if (input.swap) {
      swapLeg = await fetchJupiterSwapLeg(env, deadline, {
        inputMint: input.swap.sourceTokenMint,
        outputMint: input.tokenMint,
        sourceAmount: input.amount,
        owner: input.ownerAddress,
        payer: rentPayer,
        slippageBps: input.swap.slippageBps,
        maxAccounts,
      });
      // Sized to the swap's guaranteed floor, never its quote: the deposit
      // instruction encodes a static amount, and an ExactIn swap only promises
      // the threshold. Output above it stays in the owner's token account.
      depositAmount = swapLeg.minOutAmount;
    }

    const { quote, minSharesOut } = await quotePreparedStrategyDeposit(
      client,
      runtime,
      input,
      depositAmount
    );
    let plan: EarnVaultTransactionPlan;
    try {
      const built = await client.buildVaultDeposit(runtime, {
        providerReference: input.providerReference,
        owner: input.ownerAddress,
        amount: depositAmount,
        minSharesOut,
        // The partner fee payer funds account rent too, or nobody but the
        // owner does — the one-identity rule from vault-sponsorship.ts. This
        // is the CALLER's wallet co-signing, not Kora: SDP-side sponsorship
        // for caller-signed movements stays PRO-1744, a separate decision.
        ...(rentPayer === undefined ? {} : { rentPayer }),
      });
      plan = appendVaultRequestMemo(
        swapLeg ? prependSwapLegToVaultPlan(built, swapLeg) : built,
        "strategy-deposit",
        transactionId,
        { compact: compactMemo }
      );
    } catch (error) {
      rethrowProviderBuildFailure(error, "wallet deposit");
    }

    if (plan.cluster !== cluster) {
      throw internalError(
        `Vault builder returned a ${plan.cluster} plan for the configured ${cluster} cluster`
      );
    }
    const accepted = requireAcceptedPlan(plan, { ...input, amount: depositAmount, minSharesOut });

    try {
      // Swap-funded plans carry a LOCALLY derived compute-unit limit (see the
      // sizing note in jupiter-swap.service.ts): probe-simulate at the maximum,
      // then pin the buffered, capped consumption as the plan's first
      // instruction. Without it, a high-CU route under the 1.4M ceiling would
      // die on Solana's per-instruction default budget despite being valid.
      if (swapLeg) {
        plan = await pinProbedComputeUnitLimit({
          deadline,
          expectedAssetIdentity,
          plan,
          ownerAddress: input.ownerAddress,
          fee,
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
      const simulation = await simulateVaultPlan({
        deadline,
        expectedAssetIdentity,
        plan,
        owner: address(input.ownerAddress),
        fee,
      });
      if (!simulation.ok) {
        getLogger().error(
          { error: simulation.error, raw: simulation.raw, logs: simulation.logs.slice(-5) },
          "wallet deposit: simulation failed"
        );
        throwSimulationRefusal("Vault deposit simulation failed", simulation);
      }

      const unsigned = compileUnsignedVaultTransaction({
        deadline,
        expectedAssetIdentity,
        plan,
        owner: address(input.ownerAddress),
        feePayer: preparedFeePayer(fee),
        prepared: simulation.prepared,
      });
      return {
        fit: true,
        unsigned,
        plan,
        depositAmount,
        minSharesOut: accepted.minSharesOut,
        swapLeg,
        quote,
      };
    } catch (error) {
      // Retry oversized swap routes with fewer accounts. Every successful
      // build must still contain both the swap and the strategy deposit.
      if (swapLeg && error instanceof VaultTransactionTooLargeError) {
        return { fit: false };
      }
      throw error;
    }
  };

  let attempt = await firstWalletDepositAttempt(attemptBuild, input.swap !== undefined, fee);
  if (!attempt.fit) {
    attempt = await attemptBuild(RETRY_SWAP_MAX_ACCOUNTS, true);
  }
  if (!attempt.fit) {
    throw badRequest(
      "This swap and strategy deposit cannot fit in one Solana transaction. " +
        "Fund the wallet with the strategy's deposit token and retry.",
      { reason: "atomic_swap_deposit_too_large", depositTokenMint: input.tokenMint }
    );
  }

  const { unsigned, plan, depositAmount, minSharesOut, swapLeg, quote } = attempt;
  const built = await createPostgresEarnWalletTransactionsRepository(getDb(env)).create({
    id: transactionId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    environment,
    provider: input.provider,
    direction: "deposit",
    operationOnly: true,
    strategyId: input.strategyId,
    custodyWalletId: input.custodyWalletId,
    feeMode: storedFeeMode(fee),
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
    feePayer: vaultRentPayer(fee) ?? null,
    // Carry the planned rent payer onto the movement at submit. An idempotent
    // create can be a no-op; Kamino never uses this claim to authorize a refund.
    shareAtaRentFunder: plan.createsShareAccount === true ? (vaultRentPayer(fee) ?? null) : null,
    unsignedTransaction: Buffer.from(unsigned.bytes).toString("base64"),
    lastValidBlockHeight: unsigned.lastValidBlockHeight,
    createdBy: input.userId ?? null,
    initiatedByKeyId: input.apiKeyId ?? null,
  });
  return {
    kind: "built",
    built,
    swap: swapLeg,
    quote,
  };
}

/**
 * Probe-simulate the composed plan at the maximum compute-unit limit, then
 * pin the buffered observed consumption as its limit.
 */
async function pinProbedComputeUnitLimit(input: {
  deadline: ReturnType<typeof createVaultDeadline>;
  expectedAssetIdentity: { depositTokenMint: string; shareMint: string };
  plan: EarnVaultTransactionPlan;
  ownerAddress: string;
  fee: VaultFeeMode;
}): Promise<EarnVaultTransactionPlan> {
  const probe = await simulateVaultPlan({
    deadline: input.deadline,
    expectedAssetIdentity: input.expectedAssetIdentity,
    plan: withComputeUnitLimit(input.plan, MAX_COMPUTE_UNIT_LIMIT),
    owner: address(input.ownerAddress),
    fee: input.fee,
  });
  if (!probe.ok) {
    getLogger().error(
      { error: probe.error, raw: probe.raw, logs: probe.logs.slice(-5) },
      "wallet deposit: compute-unit probe simulation failed"
    );
    throwSimulationRefusal("Vault deposit simulation failed", probe);
  }
  return withComputeUnitLimit(input.plan, bufferedComputeUnitLimit(probe.unitsConsumed));
}

/** A wallet exit build. The open cluster scope decides its environment and cluster. */
export type WalletWithdrawalBuildInput = WalletBuildContext & {
  strategyId?: string;
  redemptionMode?: "standard" | "instant";
  provider: string;
  /** Null only for a live-discovered holding, claimed at signed submission. */
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

export async function buildWalletWithdrawalTransaction(
  env: Env,
  input: WalletWithdrawalBuildInput
): Promise<WalletBuiltTransaction> {
  const deadline = createVaultDeadline();
  // Capability is the ONLY provider-shaped refusal on this path (ADR 0002 exit
  // safety): no surfacing, no entitlement, no availability, no catalogue.
  const client = resolveVaultWithdrawClient(env, input.provider, deadline);
  if (!client) {
    throw notImplemented(input.provider, "vault withdrawals");
  }
  const { environment, cluster } = currentClusterScope();
  const transactionId = generateEarnWalletTransactionId();
  const expectedAssetIdentity = {
    depositTokenMint: input.tokenMint,
    shareMint: input.shareMint,
  };
  const runtime = earnRuntime(env);

  // Legacy provider-specific hint. Kamino ignores it for existing accounts;
  // a pre-build creation claim cannot identify the payer of their live instance.
  const rentRefundTo = input.shareAtaRentFunder ?? undefined;
  // Same one-value rule (and owner normalization) as the deposit build: the
  // fee mode drives the provider's rent payer (an exit consolidation can
  // create an account), the simulation fee payer, and the compiled seat.
  const feePayer = input.feePayer === input.ownerAddress ? undefined : input.feePayer;
  const fee = preparedStrategyFee(input, feePayer);
  const rentPayer = vaultRentPayer(fee);

  const buildPlan = async (compactMemo = false): Promise<EarnVaultTransactionPlan> => {
    try {
      if (
        input.redemptionMode !== undefined &&
        (!supportsProviderRedemptionModes(client) ||
          !client.getProviderRedemptionModes().includes(input.redemptionMode))
      )
        throw badRequest("This provider does not support the requested redemption mode");
      const built = await client.buildVaultWithdrawal(runtime, {
        providerReference: input.vaultAddress,
        owner: input.ownerAddress,
        shares: input.shares,
        redemptionMode: input.redemptionMode,
        ...(input.minAmountOut === undefined ? {} : { minAmountOut: input.minAmountOut }),
        ...(rentPayer === undefined ? {} : { rentPayer }),
        ...(rentRefundTo === undefined ? {} : { rentRefundTo }),
      });
      return appendVaultRequestMemo(built, "strategy-withdrawal", transactionId, {
        compact: compactMemo,
      });
    } catch (error) {
      rethrowProviderBuildFailure(error, "wallet withdrawal");
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
    const simulation = await simulateVaultPlan({
      deadline,
      expectedAssetIdentity,
      plan,
      owner: address(input.ownerAddress),
      fee,
    });
    if (!simulation.ok) {
      getLogger().error(
        { error: simulation.error, raw: simulation.raw, logs: simulation.logs.slice(-5) },
        "wallet withdrawal: simulation failed"
      );
      throwSimulationRefusal("Vault withdrawal simulation failed", simulation);
    }

    return compileUnsignedVaultTransaction({
      deadline,
      expectedAssetIdentity,
      plan,
      owner: address(input.ownerAddress),
      feePayer: preparedFeePayer(fee),
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

  return createPostgresEarnWalletTransactionsRepository(getDb(env)).create({
    id: transactionId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    environment,
    provider: input.provider,
    direction: "withdrawal",
    operationOnly: true,
    strategyId: input.strategyId,
    custodyWalletId: input.custodyWalletId,
    feeMode: storedFeeMode(fee),
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
    feePayer: vaultRentPayer(fee) ?? null,
    // Same planning claim as the deposit build; this is not execution evidence.
    shareAtaRentFunder: plan.createsShareAccount === true ? (vaultRentPayer(fee) ?? null) : null,
    unsignedTransaction: Buffer.from(unsigned.bytes).toString("base64"),
    lastValidBlockHeight: unsigned.lastValidBlockHeight,
    createdBy: input.userId ?? null,
    initiatedByKeyId: input.apiKeyId ?? null,
  });
}

export interface VerifiedSignedWalletTransaction {
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
export async function verifySignedWalletTransaction(
  built: Pick<
    EarnWalletTransactionRow,
    "id" | "owner_address" | "fee_payer" | "unsigned_transaction"
  >,
  signedTransactionBase64: string
): Promise<VerifiedSignedWalletTransaction> {
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
    throw internalError(`Earn wallet build ${built.id} does not require its owner to sign`);
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
