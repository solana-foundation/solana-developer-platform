import { notImplemented } from "@sdp/earn/errors";
import type { EarnRuntimeContext, EarnVaultTransactionPlan } from "@sdp/earn/types";
import { SdpKaminoError } from "@sdp/kamino";
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
import { badRequest, internalError, notFound } from "@/lib/errors";
import {
  buildEarnExternalWalletDepositFingerprint,
  buildEarnExternalWalletWithdrawalFingerprint,
  resolveIdempotencyReplay,
} from "@/lib/idempotency";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";
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
  withComputeUnitLimit,
} from "./jupiter-swap.service";
import { createVaultDeadline } from "./vault-deadline";
import { requireAcceptedPlan } from "./vault-deposit.service";
import {
  appendVaultRequestMemo,
  compileUnsignedVaultTransaction,
  simulateVaultPlan,
  type UnsignedVaultTransaction,
  VaultTransactionTooLargeError,
} from "./vault-execution.service";
import { broadcastRecordedVaultMovement } from "./vault-intent-execution.service";
import { requireAcceptedWithdrawalPlan } from "./vault-withdraw.service";

/**
 * The external-wallet (caller-signed) vault flows: SDP moves money for a wallet it
 * does NOT custody (PRO-1722, ADR 0002 addendum 2026-08-26).
 *
 * Each direction is two calls. The BUILD produces one complete unsigned
 * transaction for the external wallet — provider build, simulation with the
 * owner as fee payer, memo binding, compile — and persists it, because the
 * later submit must prove the bytes it receives are ones SDP built. The SUBMIT
 * verifies the returned signature over exactly those message bytes, records
 * the movement durably, and only then broadcasts: record-before-broadcast is
 * unchanged from the custody flow; the point where the signature becomes
 * knowable simply moved from SDP's signer to the submit call. Past the durable
 * write the two flows share one tail and one reconciler.
 *
 * NOTHING here signs, resolves a signer, or touches custody: the owner's
 * own signature is the authorization to move the owner's money, which is
 * why these paths take no wallet policy gate.
 */

export interface ExternalWalletDepositBuildInput {
  organizationId: string;
  projectId: string;
  environment: SdpEnvironment;
  provider: EarnProviderId;
  /** Vault address — the strategy's providerReference. */
  providerReference: string;
  /** The external wallet that will sign, own the shares, and pay the fee. */
  ownerAddress: string;
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
  userId?: string | null;
  apiKeyId?: string | null;
}

export type ExternalWalletDepositBuildResult =
  | {
      kind: "built";
      built: EarnExternalWalletTransactionRow;
      /** The swap leg composed into the transaction, when the build was swap-funded. */
      swap?: JupiterSwapLeg;
    }
  | {
      /**
       * The composed swap + deposit could not fit one Solana packet, even
       * after re-routing for compactness. Nothing was persisted. The caller
       * gets an unsigned SWAP-ONLY transaction to sign and broadcast itself,
       * then requests an ordinary (unswapped) build for `swap.minOutAmount`.
       */
      kind: "swap_required";
      swap: JupiterSwapLeg;
      swapTransaction: UnsignedVaultTransaction;
    };

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

  /**
   * One build attempt at a given swap route width. Swap-funded builds may run
   * it twice: the composed transaction's size is only knowable after
   * lookup-table compression, and the honest response to an overflow is a
   * more compact route, which is a fresh Jupiter quote and therefore a fresh
   * provider plan (the guaranteed output moves with the route).
   */
  const attemptBuild = async (
    maxAccounts?: number
  ): Promise<
    | {
        fit: true;
        unsigned: UnsignedVaultTransaction;
        plan: EarnVaultTransactionPlan;
        depositAmount: string;
        minSharesOut: string | null;
        swapLeg?: JupiterSwapLeg;
      }
    | { fit: false; swapLeg: JupiterSwapLeg }
  > => {
    let swapLeg: JupiterSwapLeg | undefined;
    let depositAmount = input.amount;
    if (input.swap) {
      swapLeg = await fetchJupiterSwapLeg(env, deadline, {
        inputMint: input.swap.sourceTokenMint,
        outputMint: input.tokenMint,
        sourceAmount: input.amount,
        owner: input.ownerAddress,
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
        // No rentPayer: the owner funds its own accounts, fee and rent alike.
        // Kora sponsorship for caller-signed movements is PRO-1744, not wired
        // yet: the sponsor co-signs a transaction a wallet outside SDP custody
        // also signs, which is its own design decision.
      });
      plan = appendVaultRequestMemo(
        swapLeg ? prependSwapLegToVaultPlan(built, swapLeg) : built,
        "external-deposit",
        transactionId
      );
    } catch (error) {
      getLogger().error({ error }, "external-wallet deposit: build failed");
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
    const accepted = requireAcceptedPlan(plan, { ...input, amount: depositAmount });

    // Swap-funded plans carry a LOCALLY derived compute-unit limit (see the
    // sizing note in jupiter-swap.service.ts): probe-simulate at the maximum,
    // then pin the buffered, capped consumption as the plan's first
    // instruction. Without it, a high-CU route under the 1.4M ceiling would
    // die on Solana's per-instruction default budget despite being valid.
    if (swapLeg) {
      const probe = await simulateVaultPlan(env, {
        cluster,
        deadline,
        expectedAssetIdentity,
        plan: withComputeUnitLimit(plan, MAX_COMPUTE_UNIT_LIMIT),
        owner: address(input.ownerAddress),
        rpcUrl,
        fee: { kind: "wallet-pays" },
      });
      if (!probe.ok) {
        getLogger().error(
          { error: probe.error, logs: probe.logs.slice(-5) },
          "external-wallet deposit: compute-unit probe simulation failed"
        );
        throw badRequest(`Vault deposit simulation failed: ${probe.error}`);
      }
      plan = withComputeUnitLimit(plan, bufferedComputeUnitLimit(probe.unitsConsumed));
    }

    // Simulate with the OWNER as fee payer — the shape the owner will sign.
    // This is also the funds check: an owner with no SOL or no tokens surfaces
    // here as a readable error at build time, before anyone signs anything.
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
      fee: { kind: "wallet-pays" },
    });
    if (!simulation.ok) {
      getLogger().error(
        { error: simulation.error, logs: simulation.logs.slice(-5) },
        "external-wallet deposit: simulation failed"
      );
      throw badRequest(`Vault deposit simulation failed: ${simulation.error}`);
    }

    try {
      const unsigned = compileUnsignedVaultTransaction({
        cluster,
        deadline,
        expectedAssetIdentity,
        plan,
        owner: address(input.ownerAddress),
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
      // Only a swap-funded plan has a legitimate next move on overflow; an
      // unswapped provider plan that cannot fit is the provider's own defect
      // and keeps failing loudly, exactly as before.
      if (swapLeg && error instanceof VaultTransactionTooLargeError) {
        return { fit: false, swapLeg };
      }
      throw error;
    }
  };

  let attempt = await attemptBuild();
  if (!attempt.fit) {
    attempt = await attemptBuild(RETRY_SWAP_MAX_ACCOUNTS);
  }
  if (!attempt.fit) {
    // Split flow: the swap alone, compiled through the same simulate-and-size
    // seam, for the owner to sign and broadcast itself. Deliberately NOT
    // persisted and carrying no request memo — it moves the owner's own funds
    // between the owner's own accounts, records no SDP movement, and its
    // follow-up deposit build takes the ordinary path.
    const swapLeg = attempt.swapLeg;
    return {
      kind: "swap_required",
      swap: swapLeg,
      swapTransaction: await compileStandaloneSwapTransaction(env, {
        cluster,
        deadline,
        rpcUrl,
        ownerAddress: input.ownerAddress,
        sourceTokenMint: input.swap?.sourceTokenMint ?? input.tokenMint,
        depositTokenMint: input.tokenMint,
        swapLeg,
      }),
    };
  }

  const { unsigned, plan, depositAmount, minSharesOut, swapLeg } = attempt;
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
    unsignedTransaction: Buffer.from(unsigned.bytes).toString("base64"),
    lastValidBlockHeight: unsigned.lastValidBlockHeight,
    createdBy: input.userId ?? null,
    initiatedByKeyId: input.apiKeyId ?? null,
  });
  return { kind: "built", built, ...(swapLeg === undefined ? {} : { swap: swapLeg }) };
}

/**
 * Compile the swap leg alone as one unsigned owner-signed transaction, for the
 * split flow. It rides the same simulate-then-compile seam as every vault
 * transaction — same owner-as-fee-payer funds check, same size assertion —
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
  const probe = await simulateVaultPlan(env, {
    cluster: input.cluster,
    deadline: input.deadline,
    expectedAssetIdentity: assetIdentity,
    plan: withComputeUnitLimit(bare, MAX_COMPUTE_UNIT_LIMIT),
    owner: address(input.ownerAddress),
    rpcUrl: input.rpcUrl,
    fee: { kind: "wallet-pays" },
  });
  if (!probe.ok) {
    getLogger().error(
      { error: probe.error, logs: probe.logs.slice(-5) },
      "external-wallet deposit: standalone swap probe simulation failed"
    );
    throw badRequest(`Swap simulation failed: ${probe.error}`);
  }
  const plan = withComputeUnitLimit(bare, bufferedComputeUnitLimit(probe.unitsConsumed));
  const simulation = await simulateVaultPlan(env, {
    cluster: input.cluster,
    deadline: input.deadline,
    expectedAssetIdentity: assetIdentity,
    plan,
    owner: address(input.ownerAddress),
    rpcUrl: input.rpcUrl,
    fee: { kind: "wallet-pays" },
  });
  if (!simulation.ok) {
    getLogger().error(
      { error: simulation.error, logs: simulation.logs.slice(-5) },
      "external-wallet deposit: standalone swap simulation failed"
    );
    throw badRequest(`Swap simulation failed: ${simulation.error}`);
  }
  return compileUnsignedVaultTransaction({
    cluster: input.cluster,
    deadline: input.deadline,
    expectedAssetIdentity: assetIdentity,
    plan,
    owner: address(input.ownerAddress),
    prepared: simulation.prepared,
  });
}

export interface ExternalWalletWithdrawalBuildInput {
  organizationId: string;
  projectId: string;
  environment: SdpEnvironment;
  provider: string;
  /** The EXISTING external-wallet holding being exited. */
  positionId: string;
  vaultAddress: string;
  tokenMint: string;
  shareMint: string;
  ownerAddress: string;
  label: string;
  /** Recorded rent attribution from the position row; null means the owner. */
  shareAtaRentFunder: string | null;
  /** Decimal string in share units. */
  shares: string;
  userId?: string | null;
  apiKeyId?: string | null;
}

export async function buildExternalWalletWithdrawalTransaction(
  env: Env,
  input: ExternalWalletWithdrawalBuildInput
): Promise<EarnExternalWalletTransactionRow> {
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

  // External-wallet positions record no third-party rent funder (the owner paid its own
  // rent, stored as NULL), so the refund defaults back to the owner inside the
  // builder. The recorded value is still passed through when present, for the
  // same reason the custody exit reads it from the position: refund whoever
  // actually paid, never whoever is convenient today.
  const rentRefundTo = input.shareAtaRentFunder ?? undefined;

  let plan: EarnVaultTransactionPlan;
  try {
    const built = await client.buildVaultWithdrawal(runtime, {
      providerReference: input.vaultAddress,
      owner: input.ownerAddress,
      shares: input.shares,
      ...(rentRefundTo === undefined ? {} : { rentRefundTo }),
    });
    plan = appendVaultRequestMemo(built, "external-withdrawal", transactionId);
  } catch (error) {
    getLogger().error({ error }, "external-wallet withdrawal: build failed");
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

  const simulation = await simulateVaultPlan(env, {
    cluster,
    deadline,
    expectedAssetIdentity,
    plan,
    owner: address(input.ownerAddress),
    rpcUrl,
    fee: { kind: "wallet-pays" },
  });
  if (!simulation.ok) {
    getLogger().error(
      { error: simulation.error, logs: simulation.logs.slice(-5) },
      "external-wallet withdrawal: simulation failed"
    );
    throw badRequest(`Vault withdrawal simulation failed: ${simulation.error}`);
  }

  const unsigned = compileUnsignedVaultTransaction({
    cluster,
    deadline,
    expectedAssetIdentity,
    plan,
    owner: address(input.ownerAddress),
    prepared: simulation.prepared,
  });

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
    createsShareAccount: plan.createsShareAccount === true,
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
    signature: signed.signature,
    signedTransaction: signed.signedTransactionBase64,
    lastValidBlockHeight: built.last_valid_block_height,
    requestId: input.requestId,
    idempotencyFingerprint: fingerprint,
    externalWalletTransactionId: built.id,
    createsShareAccount: built.creates_share_account,
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

interface VerifiedSignedExternalWalletTransaction {
  bytes: Uint8Array;
  signature: string;
  /** Canonical re-encoding of the verified bytes, for the ledger outbox. */
  signedTransactionBase64: string;
}

/**
 * Prove the submitted bytes are the transaction SDP built, with only
 * signatures added, and that the owner's signature is genuine.
 *
 * MESSAGE equality is the check that matters, for the same reason the
 * sponsored custody path compares messages after the paymaster round trip:
 * nothing about "it decodes" or "a signature is present" constrains the bytes
 * to the fee payer, blockhash, and instruction list SDP simulated and
 * gate-checked. The ed25519 verification then keeps garbage out of the
 * ledger: without it an invalid signature would be recorded as a durable
 * movement that parks reconcilable until its blockhash expires, failing a
 * customer minutes later for something knowable now.
 */
async function verifySignedExternalWalletTransaction(
  built: EarnExternalWalletTransactionRow,
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
  const ownerSignature = decoded.signatures[ownerAddress];
  if (ownerSignature === null || ownerSignature === undefined) {
    throw badRequest("signedTransaction is missing the owner signature");
  }
  if (Object.values(decoded.signatures).some((signature) => signature == null)) {
    throw badRequest("signedTransaction is not fully signed");
  }
  const ownerKey = await getPublicKeyFromAddress(ownerAddress);
  const validSignature = await verifySignature(
    ownerKey,
    ownerSignature as SignatureBytes,
    decoded.messageBytes
  );
  if (!validSignature) {
    throw badRequest("signedTransaction carries an invalid owner signature");
  }

  return {
    bytes: signedBytes,
    signature: getSignatureFromTransaction(decoded),
    // Canonicalized: Buffer's base64 decoder is lenient, so the stored outbox
    // value is re-encoded from the verified bytes rather than trusted verbatim.
    signedTransactionBase64: Buffer.from(signedBytes).toString("base64"),
  };
}
