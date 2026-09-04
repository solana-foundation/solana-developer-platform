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

/** Reconcile a claimed batch for the scheduled durable recovery job. */
export async function reconcileEarnVaultMovementBatch(
  env: Env,
  movements: EarnMovementRow[]
): Promise<void> {
  const ledger = createPostgresEarnMovementsRepository(getDb(env));
  const byEnvironment = groupByEnvironment(movements);

  // Sequential on purpose. Each environment opens its own RPC client and polls
  // a batch of signatures, so parallel environments only multiply endpoint load.
  for (const [environment, rows] of byEnvironment) {
    await reconcileEnvironment(env, ledger, environment, rows);
  }
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
): Promise<void> {
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
    getLogger().error(
      { environment, error },
      "earn vault reconciliation: failed to read transaction statuses"
    );
    return;
  }

  let currentBlockHeight: bigint | null = null;
  if (statuses.some((status) => status === null)) {
    try {
      currentBlockHeight = await rpc.getBlockHeight({ commitment: "confirmed" }).send();
    } catch (error) {
      getLogger().error(
        { environment, error },
        "earn vault reconciliation: failed to read block height"
      );
    }
  }

  // Sequential pacing protects the RPC endpoint and database pool from a
  // 256-way rebroadcast and write fanout.
  for (const [index, movement] of rows.entries()) {
    try {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- reconciliation pacing is intentional.
      await reconcileMovement(env, ledger, movement, statuses[index] ?? null, {
        cluster,
        rpcUrl,
        currentBlockHeight,
      });
    } catch (error) {
      getLogger().error(
        { movementId: movement.id, signature: movement.signature, error },
        "earn vault reconciliation: movement remains unsettled"
      );
    }
  }
}

async function reconcileMovement(
  env: Env,
  ledger: EarnMovementsLedger,
  movement: EarnMovementRow,
  status: SignatureStatusInfo | null,
  chain: { cluster: SolanaCluster; rpcUrl: string; currentBlockHeight: bigint | null }
): Promise<void> {
  if (status?.err) {
    await failMovement(ledger, movement, describeVaultSimulationError(status.err).message);
    return;
  }
  if (status?.confirmationStatus === "finalized") {
    const observedAt = new Date().toISOString();
    await advanceTransaction(ledger, movement, {
      toStatus: "finalized",
      confirmedAt: observedAt,
      settledAt: observedAt,
    });
    return;
  }
  if (status?.confirmationStatus === "confirmed") {
    if (movement.status === "confirmed") return;
    await advanceTransaction(ledger, movement, {
      toStatus: "confirmed",
      confirmedAt: new Date().toISOString(),
    });
    return;
  }
  if (status !== null) {
    await markSubmitted(ledger, movement);
    return;
  }
  if (movement.status === "confirmed") return;

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
    return;
  }
  if (chain.currentBlockHeight === null) return;

  await broadcastVaultTransaction(env, {
    cluster: chain.cluster,
    deadline: createVaultDeadline(),
    bytes: Uint8Array.from(Buffer.from(signedTransaction, "base64")),
    rpcUrl: chain.rpcUrl,
  });
  await markSubmitted(ledger, movement);
}

async function markSubmitted(
  ledger: EarnMovementsLedger,
  movement: EarnMovementRow
): Promise<void> {
  if (movement.status !== "requested") return;
  await advanceTransaction(ledger, movement, { toStatus: "submitted" });
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
