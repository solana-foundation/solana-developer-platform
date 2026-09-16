import type { EarnVaultAssetIdentity, EarnVaultTransactionPlan } from "@sdp/earn/types";
import { createRpc } from "@sdp/rpc/solana";
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
import { isBlockhashNotFoundError } from "./vault-simulation-error";
import type { VaultFeeMode } from "./vault-sponsorship";

/**
 * Vault programs' own words for "your floor was too high", as Anchor writes
 * them into simulation logs. Veda reports `SlippageExceeded`; Jupiter Lend
 * reports `FTokenMinAmountOut`. Matched on NAMED errors, never bare custom
 * error numbers: the same number can mean unrelated things across programs.
 */
const SLIPPAGE_SIMULATION_MARKERS = [
  "SlippageExceeded",
  "Slippage tolerance exceeded",
  // biome-ignore lint/security/noSecrets: public Jupiter Lend Anchor error name.
  "FTokenMinAmountOut",
  // biome-ignore lint/security/noSecrets: public Jupiter Lend Anchor error name.
  "fTokenMinAmountOut",
] as const;

export function isSlippageSimulationFailure(error: string, logs: readonly string[]): boolean {
  return SLIPPAGE_SIMULATION_MARKERS.some(
    (marker) => error.includes(marker) || logs.some((log) => log.includes(marker))
  );
}

/**
 * The reconciler's wording for a movement that outlived its blockhash window
 * (vault-movement-reconciliation.service.ts); the two paths record one fact.
 */
export const BLOCKHASH_EXPIRED_FAILURE_REASON = "Transaction blockhash expired before confirmation";

/** Interactive budget for a block-height read that only gates an early answer. */
const BLOCK_HEIGHT_READ_TIMEOUT_MS = 2_000;

/**
 * The cluster's confirmed block height, the same commitment the build's
 * `lastValidBlockHeight` was quoted at and the reconciler compares against.
 */
export async function readConfirmedBlockHeight(env: Env, rpcUrl: string): Promise<bigint> {
  const rpc = createRpc(env, { rpcUrl, requestTimeoutMs: BLOCK_HEIGHT_READ_TIMEOUT_MS });
  return rpc.getBlockHeight({ commitment: "confirmed" }).send();
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
        {
          error: simulation.error,
          fault: simulation.fault,
          ...(simulation.sponsorCause === undefined
            ? {}
            : { sponsorCause: simulation.sponsorCause }),
          logs: simulation.logs.slice(-5),
        },
        `vault ${operation}: simulation failed before signing`
      );
      // A sponsor fault is SDP's operational problem: a 400 would tell client
      // retry middleware the caller is at fault (permanent), and would leak
      // SDP's sponsor funding state as a pollable signal. The detail is in the
      // log line above; the caller gets a 5xx with no internals. The two
      // flavours part on the RETRY HINT only: a broke sponsor genuinely
      // clears with a refill, while a missing prefund is a plan defect and
      // "retry shortly" would be a false promise.
      if (simulation.fault === "sponsor") {
        if (simulation.sponsorCause === "prefund") {
          throw internalError(
            `Vault ${operation} simulation failed: SDP did not fund an account this ` +
              `${operation} creates. This needs an SDP-side fix; retrying will not clear it`
          );
        }
        // "Network costs" rather than "fee": the sponsor also funds the rent
        // of accounts a sponsored movement creates, and both land here.
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
 * durable `requested` row for the shared reconciler; it is never a failure,
 * with one proven exception: a preflight blockhash refusal observed past the
 * blockhash window fails the movement at once (`failExpiredBroadcast`).
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
    const expired = await failExpiredBroadcast(env, input, error);
    if (expired) return expired;
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

/**
 * Fail a movement whose broadcast preflight refused an expired blockhash.
 *
 * Two facts make this definitive where a lone broadcast error is not: the
 * preflight `BlockhashNotFound` proves the bytes never reached the network,
 * and a confirmed height past `last_valid_block_height` proves they never
 * can. The height check is not decoration: preflight simulates at a
 * commitment that can lag the one the blockhash was quoted at, so a
 * too-NEW blockhash produces the same refusal, and the reconciler's
 * rebroadcast is what lands it. Any doubt (no window on the row, height
 * unreadable, window still open) answers null and leaves the row
 * reconcilable.
 */
async function failExpiredBroadcast(
  env: Env,
  input: {
    operation: string;
    organizationId: string;
    rpcUrl: string;
    signature: string;
    movement: EarnMovementRow;
  },
  error: unknown
): Promise<EarnMovementRow | null> {
  if (!isBlockhashNotFoundError(error)) return null;
  const lastValidBlockHeight = input.movement.last_valid_block_height;
  if (lastValidBlockHeight === null) return null;

  let currentBlockHeight: bigint;
  try {
    currentBlockHeight = await readConfirmedBlockHeight(env, input.rpcUrl);
  } catch (heightError) {
    getLogger().warn(
      { movementId: input.movement.id, error: heightError },
      `vault ${input.operation}: block height unreadable after a preflight blockhash refusal; left reconcilable`
    );
    return null;
  }
  if (currentBlockHeight <= BigInt(lastValidBlockHeight)) return null;

  getLogger().warn(
    {
      movementId: input.movement.id,
      signature: input.signature,
      currentBlockHeight: currentBlockHeight.toString(),
      lastValidBlockHeight,
    },
    `vault ${input.operation}: blockhash expired before broadcast; movement failed`
  );
  const ledger = createPostgresEarnMovementsRepository(getDb(env));
  const failed = await ledger.advanceVaultMovement({
    movementId: input.movement.id,
    organizationId: input.organizationId,
    toStatus: "failed",
    failureReason: BLOCKHASH_EXPIRED_FAILURE_REASON,
  });
  if (failed) return failed;
  // The reconciler moved the row first; report whatever it recorded.
  return ledger.getMovementById({
    movementId: input.movement.id,
    organizationId: input.organizationId,
  });
}
