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
    });
    if (!simulation.ok) {
      getLogger().error(
        { error: simulation.error, logs: simulation.logs.slice(-5) },
        `vault ${operation}: simulation failed before signing`
      );
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
      fee: { kind: "wallet-pays" },
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

  try {
    await broadcastVaultTransaction(env, {
      cluster: input.cluster,
      deadline: input.deadline,
      bytes: signed.bytes,
      rpcUrl: input.rpcUrl,
    });
  } catch (error) {
    getLogger().error(
      { movementId: result.movement.id, signature: signed.signature, error },
      `vault ${operation}: broadcast outcome unknown; left reconcilable`
    );
    return result;
  }

  const ledger = createPostgresEarnMovementsRepository(getDb(env));
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
    `Vault ${operation} was broadcast but its ledger transition could not be verified`
  );
}
