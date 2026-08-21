import { notImplemented } from "@sdp/earn/errors";
import type { EarnRuntimeContext, EarnVaultTransactionPlan } from "@sdp/earn/types";
import { SdpKaminoError } from "@sdp/kamino";
import { createRpc, getSignatureStatuses, type SignatureStatusInfo } from "@sdp/rpc/solana";
import { compareDecimalAmounts, isDecimalString } from "@sdp/solana/amount";
import type { SdpEnvironment } from "@sdp/types";
import { address, type Signature } from "@solana/kit";
import { type AppDb, getDb } from "@/db";
import {
  assertMovementIsOwnReplay,
  createPostgresEarnMovementsRepository,
  type EarnMovementRow,
  type EarnPositionRow,
  type EarnVaultWithdrawalLegRow,
  type SignedVaultWithdrawalLegInput,
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
import { createVaultDeadline, type VaultDeadline } from "./vault-deadline";
import {
  appendVaultRequestMemo,
  broadcastVaultTransaction,
  type SignedVaultTransaction,
  signVaultPlanTransactions,
  simulateVaultPlan,
} from "./vault-execution.service";

/**
 * Exit a non-custodial vault position: build the provider's withdrawal plan,
 * sign every transaction leg with the org's own custody wallet, record all of
 * them, then submit in order.
 *
 * Ordering is the deposit's `build → simulate → sign → record → send`, with one
 * multi-leg extension: EVERY leg is signed and durably recorded before the
 * FIRST byte reaches the wire, so a crash at any point leaves a group the
 * reconciliation sweep can finish or fail honestly — nothing is ever on chain
 * that the ledger cannot reconcile by signature. Legs broadcast strictly in
 * order, each only after its predecessor reaches optimistic commitment,
 * because a later leg's instructions may consume state an earlier one creates.
 * When the request's budget runs out mid-group, the recorded legs are the
 * resume point, not a loss.
 *
 * GATES ARE THE CALLER'S JOB, and there are deliberately almost none: ADR 0002
 * exit safety means a withdrawal never checks surfacing, entitlement,
 * availability, environment capability, or the CATALOGUE — the position row is
 * the source of truth for the instrument, so a delisted vault stays exitable.
 * This service checks only what makes the transaction itself safe: the plan's
 * asset identity against the POSITION's recorded mints, and the plan's encoded
 * quantities against the request.
 */

export interface VaultWithdrawalInput {
  organizationId: string;
  projectId: string;
  environment: SdpEnvironment;
  /** From the position row — an open registry string, resolved by capability. */
  provider: string;
  positionId: string;
  /** The position's instrument and claim facts, trusted from its own row. */
  vaultAddress: string;
  tokenMint: string;
  shareMint: string;
  wallet: { id: string; walletId: string; publicKey: string };
  /** Shares to redeem, decimal string in share units. */
  shares: string;
  /** Caller idempotency key. */
  requestId: string;
  userId?: string | null;
  apiKeyId?: string | null;
}

export interface VaultWithdrawalResult {
  position: EarnPositionRow;
  /** The single business movement exposed to API and ledger consumers. */
  movement: EarnMovementRow;
  /** Internal signed transactions, retained for execution and diagnostics. */
  legs: EarnVaultWithdrawalLegRow[];
  /** True when an existing signed group won; none of its bytes were re-sent. */
  replayed: boolean;
}

export interface VaultWithdrawalExecutionOptions {
  /**
   * Handler-owned boundary that couples an approved-operation effect fence to
   * the repository's first durable mutation — the deposit's contract, group
   * shaped. The repository still opens a real transaction for ordinary calls.
   */
  runIntentTransaction?: <T>(mutation: (db: AppDb) => Promise<T>) => Promise<T>;
}

/** How long to pause between commitment polls while a leg is landing. */
const LEG_COMMITMENT_POLL_INTERVAL_MS = 1_000;

/**
 * Trust-but-verify on the builder's output, mirroring the deposit's
 * `requireAcceptedPlan`: the plan must move exactly what was requested, on
 * exactly the instrument the POSITION records, and carry the per-leg share
 * quantities the ledger rows are about to state as fact.
 */
function requireAcceptedWithdrawalPlan(
  plan: EarnVaultTransactionPlan,
  input: Pick<VaultWithdrawalInput, "tokenMint" | "shareMint" | "shares">
): { transactionShares: string[] } {
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
  const transactionShares = plan.transactionShares;
  if (!transactionShares || transactionShares.length !== plan.transactions.length) {
    throw internalError("Vault builder did not report per-transaction share quantities");
  }
  for (const legShares of transactionShares) {
    if (!isDecimalString(legShares) || !/[1-9]/.test(legShares)) {
      throw internalError("Vault builder reported a transaction leg that redeems no shares");
    }
  }
  return { transactionShares: [...transactionShares] };
}

/**
 * Poll one broadcast leg to optimistic commitment within the request budget.
 *
 * Returns the observed status once the chain reports commitment or an
 * execution error, or null when the budget ran out first — at which point the
 * recorded rows are the sweep's to finish, not a failure.
 */
async function waitForLegCommitment(
  env: Env,
  deadline: VaultDeadline,
  rpcUrl: string,
  signature: string
): Promise<SignatureStatusInfo | null> {
  const rpc = createRpc(env, { rpcUrl });
  for (;;) {
    let status: SignatureStatusInfo | null;
    try {
      const statuses = await deadline.run("Confirming the vault withdrawal leg", () =>
        getSignatureStatuses(rpc, [signature as Signature])
      );
      status = statuses[0] ?? null;
    } catch {
      // Budget elapsed or a transport error — both leave the leg reconcilable
      // by its recorded signature; neither is a verdict about the transaction.
      return null;
    }
    if (status?.err) return status;
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return status;
    }
    try {
      await deadline.run(
        "Waiting for vault withdrawal leg commitment",
        () => new Promise<void>((resolve) => setTimeout(resolve, LEG_COMMITMENT_POLL_INTERVAL_MS))
      );
    } catch {
      return null;
    }
  }
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

  // Fast sequential replay path — a pure durable read that must keep working
  // during an RPC outage. The atomic insert below repeats the check to close
  // the concurrent race; this only avoids rebuilding and re-signing a group
  // whose signed rows already exist.
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
    if (prior.direction !== "withdrawal") {
      throw internalError(`Replayed movement ${prior.id} is not a vault withdrawal`);
    }
    const legs = await ledger.listVaultWithdrawalLegs({
      organizationId: input.organizationId,
      movementId: prior.id,
    });
    const position = await ledger.getPositionById({
      organizationId: input.organizationId,
      environment: input.environment,
      positionId: prior.position_id,
    });
    if (!position || legs.length === 0) {
      throw internalError(`Replayed withdrawal ${prior.id} references missing execution details`);
    }
    return { position, movement: prior, legs, replayed: true };
  }

  const deadline = createVaultDeadline();
  const client = resolveVaultWithdrawClient(env, input.provider, deadline);
  if (!client) {
    throw notImplemented(input.provider, "vault withdrawals");
  }
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
  const { transactionShares } = requireAcceptedWithdrawalPlan(plan, input);

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

  let signed: SignedVaultTransaction[];
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
    signed = await signVaultPlanTransactions(env, {
      cluster,
      deadline,
      expectedAssetIdentity,
      plan,
      owner: signer,
      rpcUrl,
      // The custody wallet pays its own exit fees, exactly like the deposit:
      // Kora only sponsors allow-listed programs and the kvault/klend ids are
      // not among them.
      fee: { kind: "wallet-pays" },
    });
  } catch (error) {
    getLogger().error({ error }, "vault withdrawal: signer resolution or signing failed");
    throw error;
  }

  const signedLegs: SignedVaultWithdrawalLegInput[] = signed.map((transaction, index) => {
    const shares = transactionShares[index];
    if (!shares) {
      throw internalError(`Vault withdrawal leg ${index} has no share quantity to record`);
    }
    return {
      shares,
      signature: transaction.signature,
      signedTransaction: Buffer.from(transaction.bytes).toString("base64"),
      lastValidBlockHeight: transaction.lastValidBlockHeight,
    };
  });

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
      legs: signedLegs,
      requestId: input.requestId,
      idempotencyFingerprint: fingerprint,
      createdBy: input.userId ?? null,
      initiatedByKeyId: input.apiKeyId ?? null,
    })
  );

  // A concurrent identical request already owns the durable signatures. Its
  // signed bytes — not ours — are the only ones that may be broadcast.
  if (result.replayed) return result;

  const legs = [...result.legs];
  let movement = result.movement;
  await submitWithdrawalLegs(env, {
    ledger,
    deadline,
    cluster,
    rpcUrl,
    organizationId: input.organizationId,
    movement,
    legs,
    signed,
    onMovement: (next) => {
      movement = next;
    },
  });
  return { ...result, movement, legs };
}

/**
 * Broadcast recorded legs in order, advancing each row as its fate is
 * observed. Mutates `movements` in place so the caller returns the freshest
 * status every leg reached within the request budget.
 *
 * Every early return leaves the remaining legs `requested` WITH recorded
 * bytes, which is exactly the state the reconciliation sweep resumes from —
 * its predecessor gate enforces the same ordering this loop does.
 */
async function submitWithdrawalLegs(
  env: Env,
  input: {
    ledger: ReturnType<typeof createPostgresEarnMovementsRepository>;
    deadline: VaultDeadline;
    cluster: ReturnType<typeof earnClusterFor>;
    rpcUrl: string;
    organizationId: string;
    movement: EarnMovementRow;
    legs: EarnVaultWithdrawalLegRow[];
    signed: readonly SignedVaultTransaction[];
    onMovement: (movement: EarnMovementRow) => void;
  }
): Promise<void> {
  const { ledger, legs } = input;
  const advance = async (
    index: number,
    change: Omit<Parameters<typeof ledger.advanceVaultMovement>[0], "movementId" | "organizationId">
  ) => {
    const advanced = await ledger.advanceVaultWithdrawalLeg({
      movementId: input.movement.id,
      legIndex: index,
      organizationId: input.organizationId,
      ...change,
    });
    if (advanced) {
      legs[index] = advanced.leg;
      input.onMovement(advanced.movement);
    }
    return advanced;
  };

  for (let index = 0; index < legs.length; index += 1) {
    const bytes = input.signed[index]?.bytes;
    if (!bytes) return;
    try {
      await broadcastVaultTransaction(env, {
        cluster: input.cluster,
        deadline: input.deadline,
        bytes,
        rpcUrl: input.rpcUrl,
      });
    } catch (error) {
      // Timeout/transport failure is ambiguous: the leg may have landed. Leave
      // it (and every later leg) pending for the sweep; broadcasting the next
      // leg now could land it before a predecessor whose fate is unknown.
      getLogger().error(
        { movementId: input.movement.id, signature: legs[index].signature, error },
        "vault withdrawal: leg broadcast outcome unknown; left reconcilable"
      );
      return;
    }
    await advance(index, { toStatus: "submitted" });

    // The last leg needs no in-request wait: the sweep settles it like any
    // deposit. Intermediate legs must reach commitment before their successor
    // may be broadcast.
    if (index === legs.length - 1) return;

    const status = await waitForLegCommitment(
      env,
      input.deadline,
      input.rpcUrl,
      legs[index].signature
    );
    if (status === null) return;
    if (status.err) {
      await advance(index, {
        toStatus: "failed",
        failureReason: JSON.stringify(status.err),
      });
      // The remaining legs were built against state this leg was meant to
      // produce; submitting them would burn fees on transactions that cannot
      // succeed. Fail them now rather than lazily — the shares they would have
      // redeemed remain in the wallet and are immediately re-withdrawable.
      for (let rest = index + 1; rest < legs.length; rest += 1) {
        await advance(rest, {
          toStatus: "failed",
          failureReason: `Predecessor withdrawal leg ${legs[index].signature} failed on chain`,
        });
      }
      return;
    }
    await advance(index, {
      toStatus: "confirmed",
      confirmedAt: new Date().toISOString(),
    });
  }
}
