import type { EarnVaultAssetIdentity, EarnVaultTransactionPlan } from "@sdp/earn/types";
import type { SolanaCluster } from "@sdp/types";
import { address } from "@solana/kit";
import { type AppDb, getDb } from "@/db";
import {
  createPostgresEarnMovementsRepository,
  type EarnMovementRow,
} from "@/db/repositories/earn-movements.repository";
import { badRequest, internalError } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import * as solanaServices from "@/services/solana";
import type { Env } from "@/types/env";
import type { VaultDeadline } from "./vault-deadline";
import {
  broadcastVaultTransaction,
  type PreparedVaultPlanExecution,
  type SignedVaultTransaction,
  signVaultPlan,
  simulateVaultPlan,
} from "./vault-execution.service";
import type { VaultFeeMode } from "./vault-sponsorship";

/**
 * The vault program's own words for "your floor was too high", as Anchor
 * writes them into simulation logs (`Error Code: SlippageExceeded. … Error
 * Message: Slippage tolerance exceeded.`). Matched on the NAMED error, never
 * the bare custom-error number: 6000 is every Anchor program's first error
 * code, so the number alone would relabel unrelated failures.
 */
const SLIPPAGE_SIMULATION_MARKERS = ["SlippageExceeded", "Slippage tolerance exceeded"] as const;

function isSlippageSimulationFailure(error: string, logs: readonly string[]): boolean {
  return SLIPPAGE_SIMULATION_MARKERS.some(
    (marker) => error.includes(marker) || logs.some((log) => log.includes(marker))
  );
}

interface SignedVaultIntentResult {
  movement: EarnMovementRow;
  replayed: boolean;
}

export interface ExecuteSignedVaultIntentInput<TResult extends SignedVaultIntentResult> {
  operation: "deposit" | "withdrawal";
  env: Env;
  organizationId: string;
  projectId: string;
  walletId: string;
  walletPublicKey: string;
  signerMismatchMessage: string;
  cluster: SolanaCluster;
  deadline: VaultDeadline;
  expectedAssetIdentity: EarnVaultAssetIdentity;
  plan: EarnVaultTransactionPlan;
  rpcUrl: string;
  /**
   * Who pays, resolved by the caller BEFORE it built the plan, because a
   * sponsor also has to be named inside the instructions as the rent payer.
   * The same value reaches simulation and signing so they cannot disagree.
   */
  fee: VaultFeeMode;
  runIntentTransaction?: <T>(mutation: (db: AppDb) => Promise<T>) => Promise<T>;
  persist: (db: AppDb, signed: SignedVaultTransaction) => Promise<TResult>;
}

/**
 * Execute the invariant vault tail once for both money directions.
 *
 * The order is deliberate and shared: simulate, resolve signer, sign, persist
 * signed bytes, broadcast, then reconcile the optimistic submitted transition.
 * A broadcast error is ambiguous and leaves the durable requested row for the
 * shared reconciler. An idempotency loser never broadcasts its unused bytes.
 */
export async function executeSignedVaultIntent<TResult extends SignedVaultIntentResult>(
  input: ExecuteSignedVaultIntentInput<TResult>
): Promise<TResult> {
  const { env, operation } = input;

  let prepared: PreparedVaultPlanExecution;
  try {
    const simulation = await simulateVaultPlan(env, {
      cluster: input.cluster,
      deadline: input.deadline,
      expectedAssetIdentity: input.expectedAssetIdentity,
      plan: input.plan,
      owner: address(input.walletPublicKey),
      rpcUrl: input.rpcUrl,
      fee: input.fee,
    });
    if (!simulation.ok) {
      getLogger().error(
        { error: simulation.error, fault: simulation.fault, logs: simulation.logs.slice(-5) },
        `vault ${operation}: simulation failed before signing`
      );
      // A broke sponsor is SDP's operational problem: a 400 would tell client
      // retry middleware the caller is at fault (permanent), and would leak
      // SDP's sponsor funding state as a pollable signal. The detail is in the
      // log line above; the caller gets a retryable 5xx with no internals.
      // "Network costs" rather than "fee": the sponsor also funds the rent of
      // accounts a sponsored movement creates, and both shortfalls land here.
      if (simulation.fault === "sponsor") {
        throw internalError(
          `Vault ${operation} simulation failed: SDP could not sponsor the network costs. Retry shortly`
        );
      }
      // A blown floor is the CALLER's tolerance, not a fault: name it in their
      // terms and carry a machine-readable reason so the dashboard can reopen
      // its slippage control instead of printing a program log.
      if (isSlippageSimulationFailure(simulation.error, simulation.logs)) {
        throw badRequest(
          `Vault ${operation} simulation failed: the vault would return less than the ` +
            "request's slippage floor allows. Raise the slippage tolerance (or lower the " +
            "floor) and try again.",
          { reason: "slippage_exceeded" }
        );
      }
      throw badRequest(`Vault ${operation} simulation failed: ${simulation.error}`);
    }
    prepared = simulation.prepared;
  } catch (error) {
    if (
      !(error instanceof Error && error.message.startsWith(`Vault ${operation} simulation failed:`))
    ) {
      getLogger().error({ error }, `vault ${operation}: simulation call failed before signing`);
    }
    throw error;
  }

  let signed: SignedVaultTransaction;
  try {
    const signer = await input.deadline.run(`Resolving the vault ${operation} signer`, () =>
      solanaServices.createOrgSignerForCustodyWallet(
        env,
        input.organizationId,
        input.projectId,
        input.walletId
      )
    );
    if (signer.address !== input.walletPublicKey) {
      throw badRequest(input.signerMismatchMessage);
    }
    signed = await signVaultPlan(env, {
      cluster: input.cluster,
      deadline: input.deadline,
      expectedAssetIdentity: input.expectedAssetIdentity,
      plan: input.plan,
      owner: signer,
      rpcUrl: input.rpcUrl,
      fee: input.fee,
      prepared,
    });
  } catch (error) {
    getLogger().error({ error }, `vault ${operation}: signer resolution or signing failed`);
    throw error;
  }

  const runIntentTransaction =
    input.runIntentTransaction ??
    (<T>(mutation: (db: AppDb) => Promise<T>) => mutation(getDb(env)));
  const result = await runIntentTransaction((db) => input.persist(db, signed));
  if (result.replayed) return result;

  const movement = await broadcastRecordedVaultMovement(env, {
    operation,
    organizationId: input.organizationId,
    cluster: input.cluster,
    deadline: input.deadline,
    rpcUrl: input.rpcUrl,
    bytes: signed.bytes,
    signature: signed.signature,
    movement: result.movement,
  });
  return { ...result, movement };
}

/**
 * The invariant tail past the durable write, shared by every vault money
 * mover: broadcast the recorded bytes, then reconcile the optimistic
 * `submitted` transition. A broadcast error is ambiguous and leaves the
 * durable `requested` row for the shared reconciler; it is never a failure.
 *
 * Split out of `executeSignedVaultIntent` for the caller-signed external-wallet flow
 * (PRO-1722), which records a movement it never signed and so has no
 * simulate/sign head — but past the durable write the two paths must not
 * differ at all.
 */
export async function broadcastRecordedVaultMovement(
  env: Env,
  input: {
    operation: string;
    organizationId: string;
    cluster: SolanaCluster;
    deadline: VaultDeadline;
    rpcUrl: string;
    bytes: Uint8Array;
    signature: string;
    movement: EarnMovementRow;
  }
): Promise<EarnMovementRow> {
  try {
    await broadcastVaultTransaction(env, {
      cluster: input.cluster,
      deadline: input.deadline,
      bytes: input.bytes,
      rpcUrl: input.rpcUrl,
    });
  } catch (error) {
    getLogger().error(
      { movementId: input.movement.id, signature: input.signature, error },
      `vault ${input.operation}: broadcast outcome unknown; left reconcilable`
    );
    return input.movement;
  }

  const ledger = createPostgresEarnMovementsRepository(getDb(env));
  const advanced = await ledger.advanceVaultMovement({
    movementId: input.movement.id,
    organizationId: input.organizationId,
    toStatus: "submitted",
  });
  if (advanced) return advanced;

  const observed = await ledger.getMovementById({
    movementId: input.movement.id,
    organizationId: input.organizationId,
  });
  if (observed?.signature === input.signature) {
    return observed;
  }
  throw internalError(
    `Vault ${input.operation} was broadcast but its ledger transition could not be verified`
  );
}
