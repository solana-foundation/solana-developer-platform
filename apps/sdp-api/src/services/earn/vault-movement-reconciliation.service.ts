import { createRpc, getSignatureStatuses, type SignatureStatusInfo } from "@sdp/rpc/solana";
import {
  EARN_TERMINAL_MOVEMENT_STATUSES,
  type SdpEnvironment,
  type SolanaCluster,
} from "@sdp/types";
import type { Signature } from "@solana/kit";
import { getDb } from "@/db";
import {
  createPostgresEarnMovementsRepository,
  type EarnMovementRow,
} from "@/db/repositories/earn-movements.repository";
import { getLogger } from "@/runtime/logger";
import { describeError, logEvent } from "@/runtime/money-path-events";
import {
  assertClusterEndpoint,
  earnClusterFor,
  resolveClusterRpcUrl,
} from "@/services/earn/execution-registry";
import { createVaultDeadline } from "@/services/earn/vault-deadline";
import { broadcastVaultTransaction } from "@/services/earn/vault-execution.service";
import { describeVaultSimulationError } from "@/services/earn/vault-simulation-error";
import type { Env } from "@/types/env";

type EarnMovementsLedger = ReturnType<typeof createPostgresEarnMovementsRepository>;

const TERMINAL_VAULT_MOVEMENT_STATUSES = new Set<string>(
  EARN_TERMINAL_MOVEMENT_STATUSES.vault_direct
);
const INTERACTIVE_RPC_TIMEOUT_MS = 2_000;

/**
 * Coalesce concurrent reads for the same movement. This protects the RPC when
 * multiple dashboard tabs watch one signature at the same time. The entry is
 * removed as soon as the observation finishes, so the next client poll can see
 * a new chain commitment immediately.
 */
const inFlightReadThroughReconciliations = new Map<string, Promise<EarnMovementRow>>();

/**
 * Observe one already-scoped vault movement directly on Solana and project the
 * result through the ledger's guarded transition writer.
 *
 * This is the interactive fast path. It never rebroadcasts or expires an
 * unknown signature from a GET request. The scheduled reconciler remains the
 * durable recovery path for ambiguous broadcasts, expired blockhashes, closed
 * tabs, and RPC outages.
 *
 * RPC failure is deliberately fail-soft: the caller receives its last durable
 * row and keeps polling while the scheduled reconciler continues independently.
 */
export function reconcileEarnVaultMovementReadThrough(
  env: Env,
  movement: EarnMovementRow
): Promise<EarnMovementRow> {
  if (TERMINAL_VAULT_MOVEMENT_STATUSES.has(movement.status)) {
    return Promise.resolve(movement);
  }

  const existing = inFlightReadThroughReconciliations.get(movement.id);
  if (existing) return resolveInteractiveObservation(existing, movement);

  const observation = observeEarnVaultMovement(env, movement).catch((error) => {
    getLogger().warn(
      { movementId: movement.id, signature: movement.signature, error },
      "earn vault reconciliation: interactive status read fell back to durable state"
    );
    return movement;
  });
  inFlightReadThroughReconciliations.set(movement.id, observation);
  void observation.finally(() => {
    if (inFlightReadThroughReconciliations.get(movement.id) === observation) {
      inFlightReadThroughReconciliations.delete(movement.id);
    }
  });
  return resolveInteractiveObservation(observation, movement);
}

/**
 * Keep an RPC outage from turning a status poll into a long request. The shared
 * observation remains alive and may still update the ledger; only this HTTP
 * response falls back to the last durable row after the interactive deadline.
 */
function resolveInteractiveObservation(
  observation: Promise<EarnMovementRow>,
  fallback: EarnMovementRow
): Promise<EarnMovementRow> {
  return new Promise((resolve) => {
    let answered = false;
    const timer = setTimeout(() => {
      answered = true;
      resolve(fallback);
    }, INTERACTIVE_RPC_TIMEOUT_MS);

    void observation.then((movement) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      resolve(movement);
    });
  });
}

async function observeEarnVaultMovement(
  env: Env,
  movement: EarnMovementRow
): Promise<EarnMovementRow> {
  if (!movement.signature) {
    throw new Error(`Earn vault movement ${movement.id} is missing its transaction signature`);
  }

  const ledger = createPostgresEarnMovementsRepository(getDb(env));
  const cluster = earnClusterFor(movement.environment);
  const rpcUrl = resolveClusterRpcUrl(env, cluster);
  const rpc = createRpc(env, { rpcUrl, requestTimeoutMs: INTERACTIVE_RPC_TIMEOUT_MS });

  await assertClusterEndpoint(env, cluster, rpcUrl);
  const [status] = await getSignatureStatuses(rpc, [movement.signature as Signature], {
    searchTransactionHistory: true,
    retryDelaysMs: [],
  });

  // A detail GET may observe and record chain truth, but it must not turn a read
  // into a rebroadcast or expiry decision. Passing no block height makes the
  // shared transition function leave an unknown signature for the durable job.
  await reconcileMovement(env, ledger, movement, status ?? null, {
    cluster,
    rpcUrl,
    currentBlockHeight: null,
  });

  return (
    (await ledger.getMovementById({
      movementId: movement.id,
      organizationId: movement.organization_id,
    })) ?? movement
  );
}

/**
 * What one sweep tick did with the batch it claimed (PRO-1863). `settled` and
 * `failed` count TRANSITIONS this tick performed, not steady state; the read
 * failures are the counts that must make the tick read failed rather than ok.
 */
export interface EarnVaultReconciliationStats {
  claimed: number;
  settled: number;
  failed: number;
  confirmed: number;
  resubmitted: number;
  unchanged: number;
  movementErrors: number;
  statusReadFailures: number;
  blockHeightReadFailures: number;
}

type MovementOutcome = "settled" | "failed" | "confirmed" | "resubmitted" | "unchanged";

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function emptyStats(claimed: number): EarnVaultReconciliationStats {
  return {
    claimed,
    settled: 0,
    failed: 0,
    confirmed: 0,
    resubmitted: 0,
    unchanged: 0,
    movementErrors: 0,
    statusReadFailures: 0,
    blockHeightReadFailures: 0,
  };
}

/** Reconcile a claimed batch for the scheduled durable recovery job. */
export async function reconcileEarnVaultMovementBatch(
  env: Env,
  movements: EarnMovementRow[]
): Promise<EarnVaultReconciliationStats> {
  const ledger = createPostgresEarnMovementsRepository(getDb(env));
  const byEnvironment = groupByEnvironment(movements);
  const stats = emptyStats(movements.length);

  // Sequential on purpose. Each environment opens its own RPC client and polls
  // a batch of signatures, so parallel environments only multiply endpoint load.
  // One environment's RPC outage is counted and reported, never allowed to
  // skip the other environment's batch.
  for (const [environment, rows] of byEnvironment) {
    const outcome = await reconcileEnvironment(env, ledger, environment, rows);
    stats.settled += outcome.settled;
    stats.failed += outcome.failed;
    stats.confirmed += outcome.confirmed;
    stats.resubmitted += outcome.resubmitted;
    stats.unchanged += outcome.unchanged;
    stats.movementErrors += outcome.movementErrors;
    stats.statusReadFailures += outcome.statusReadFailures;
    stats.blockHeightReadFailures += outcome.blockHeightReadFailures;
  }
  return stats;
}

function groupByEnvironment(movements: EarnMovementRow[]) {
  const byEnvironment = new Map<EarnMovementRow["environment"], EarnMovementRow[]>();
  for (const movement of movements) {
    const rows = byEnvironment.get(movement.environment);
    if (rows) rows.push(movement);
    else byEnvironment.set(movement.environment, [movement]);
  }
  return byEnvironment;
}

async function reconcileEnvironment(
  env: Env,
  ledger: EarnMovementsLedger,
  environment: SdpEnvironment,
  rows: EarnMovementRow[]
): Promise<EarnVaultReconciliationStats> {
  const stats = emptyStats(rows.length);
  const cluster = earnClusterFor(environment);
  const rpcUrl = resolveClusterRpcUrl(env, cluster);
  const rpc = createRpc(env, { rpcUrl });
  let statuses: Array<SignatureStatusInfo | null>;
  try {
    await assertClusterEndpoint(env, cluster, rpcUrl);
    statuses = await getSignatureStatuses(
      rpc,
      rows.map((row) => row.signature as Signature),
      { searchTransactionHistory: true }
    );
  } catch (error) {
    // The whole batch went unjudged: nothing settles this tick and the caller
    // must not report an ok tick (EARN-006). Structured so Loki can alert on
    // the event name rather than a log-line substring.
    logEvent("error", {
      event: "sdp_api_earn_vault_reconciliation_status_read_failed",
      environment,
      rows: rows.length,
      ...describeError(error),
      // describeError carries only the error NAME and code; without the message
      // the alert this event feeds fires with nothing to diagnose from.
      error_message: errorMessage(error),
    });
    stats.statusReadFailures = 1;
    stats.unchanged = rows.length;
    return stats;
  }

  // Only a null-status row that is NOT already confirmed can consume the
  // height: reconcileMovement short-circuits a confirmed row to "unchanged"
  // before ever reading it. A confirmed signature that has aged out of RPC
  // history is a permanent, expected member of the claim set (PRO-1716 plus
  // the claim query's reserved confirmed quota), so gating on the RPC answer
  // alone spent a discarded chain call every minute AND let its failure fail a
  // tick that had done its entire job. Gate the READ, so the failure
  // accounting below is correct by construction.
  const needsBlockHeight = rows.some(
    (row, index) => (statuses[index] ?? null) === null && row.status !== "confirmed"
  );
  let currentBlockHeight: bigint | null = null;
  if (needsBlockHeight) {
    try {
      currentBlockHeight = await rpc.getBlockHeight({ commitment: "confirmed" }).send();
    } catch (error) {
      // Unknown signatures cannot be rebroadcast or expired without a height,
      // so those rows are left for the next tick; the tick still must not
      // read ok, because the sweep could not do its recovery duty.
      logEvent("error", {
        event: "sdp_api_earn_vault_reconciliation_block_height_read_failed",
        environment,
        ...describeError(error),
        error_message: errorMessage(error),
      });
      stats.blockHeightReadFailures = 1;
    }
  }

  // Sequential pacing protects the RPC endpoint and database pool from a
  // 256-way rebroadcast and write fanout.
  for (const [index, movement] of rows.entries()) {
    try {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- reconciliation pacing is intentional.
      const outcome = await reconcileMovement(env, ledger, movement, statuses[index] ?? null, {
        cluster,
        rpcUrl,
        currentBlockHeight,
      });
      if (outcome === "settled") stats.settled += 1;
      else if (outcome === "failed") stats.failed += 1;
      else if (outcome === "confirmed") stats.confirmed += 1;
      else if (outcome === "resubmitted") stats.resubmitted += 1;
      else stats.unchanged += 1;
    } catch (error) {
      stats.movementErrors += 1;
      getLogger().error(
        { movementId: movement.id, signature: movement.signature, error },
        "earn vault reconciliation: movement remains unsettled"
      );
    }
  }
  return stats;
}

async function reconcileMovement(
  env: Env,
  ledger: EarnMovementsLedger,
  movement: EarnMovementRow,
  status: SignatureStatusInfo | null,
  chain: { cluster: SolanaCluster; rpcUrl: string; currentBlockHeight: bigint | null }
): Promise<MovementOutcome> {
  if (status?.err) {
    await failMovement(ledger, movement, describeVaultSimulationError(status.err).message);
    return "failed";
  }
  if (status?.confirmationStatus === "finalized") {
    const observedAt = new Date().toISOString();
    await advanceTransaction(ledger, movement, {
      toStatus: "finalized",
      confirmedAt: observedAt,
      settledAt: observedAt,
    });
    return "settled";
  }
  if (status?.confirmationStatus === "confirmed") {
    if (movement.status === "confirmed") return "unchanged";
    await advanceTransaction(ledger, movement, {
      toStatus: "confirmed",
      confirmedAt: new Date().toISOString(),
    });
    return "confirmed";
  }
  if (status !== null) {
    return (await markSubmitted(ledger, movement)) ? "resubmitted" : "unchanged";
  }
  if (movement.status === "confirmed") return "unchanged";

  const signedTransaction = movement.signed_transaction;
  const lastValidBlockHeight = movement.last_valid_block_height;
  if (signedTransaction === null || lastValidBlockHeight === null) {
    throw new Error(
      `Earn vault movement ${movement.id} is missing the signed transaction it must be reconciled from`
    );
  }

  if (
    chain.currentBlockHeight !== null &&
    chain.currentBlockHeight > BigInt(lastValidBlockHeight)
  ) {
    await failMovement(ledger, movement, "Transaction blockhash expired before confirmation");
    return "failed";
  }
  if (chain.currentBlockHeight === null) return "unchanged";

  await broadcastVaultTransaction(env, {
    cluster: chain.cluster,
    deadline: createVaultDeadline(),
    bytes: Uint8Array.from(Buffer.from(signedTransaction, "base64")),
    rpcUrl: chain.rpcUrl,
  });
  await markSubmitted(ledger, movement);
  return "resubmitted";
}

async function markSubmitted(
  ledger: EarnMovementsLedger,
  movement: EarnMovementRow
): Promise<boolean> {
  if (movement.status !== "requested") return false;
  await advanceTransaction(ledger, movement, { toStatus: "submitted" });
  return true;
}

async function failMovement(
  ledger: EarnMovementsLedger,
  movement: EarnMovementRow,
  reason: string
): Promise<void> {
  await advanceTransaction(ledger, movement, { toStatus: "failed", failureReason: reason });
}

async function advanceTransaction(
  ledger: EarnMovementsLedger,
  movement: EarnMovementRow,
  change: {
    toStatus: string;
    failureReason?: string;
    confirmedAt?: string;
    settledAt?: string;
  }
): Promise<void> {
  await ledger.advanceVaultMovement({
    movementId: movement.id,
    organizationId: movement.organization_id,
    ...change,
  });
}
