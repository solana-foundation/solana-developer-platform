import { createRpc, getSignatureStatuses, type SignatureStatusInfo } from "@sdp/rpc/solana";
import type { SdpEnvironment, SolanaCluster } from "@sdp/types";
import type { Signature } from "@solana/kit";
import { getDb } from "@/db";
import {
  createPostgresEarnMovementsRepository,
  type EarnMovementRow,
} from "@/db/repositories/earn-movements.repository";
import { createPostgresEarnVaultRepository } from "@/db/repositories/earn-vault.repository";
import { getLogger } from "@/runtime/logger";
import {
  assertClusterEndpoint,
  earnClusterFor,
  resolveClusterRpcUrl,
} from "@/services/earn/execution-registry";
import { createVaultDeadline } from "@/services/earn/vault-deadline";
import { broadcastVaultTransaction } from "@/services/earn/vault-execution.service";
import type { Env } from "@/types/env";

const OUTBOX_BATCH_SIZE = 256;

/**
 * Reconcile every recorded signed vault transaction to an IRREVERSIBLE outcome.
 *
 * "Terminal" moved (PRO-1716). Optimistic commitment is not settlement — a
 * confirmed transaction can still be dropped in a fork rollback — so the queue
 * now includes `confirmed` rows and the sweep keeps polling them until the chain
 * says `finalized`. One meaning of settled across SDP, matching what payments
 * does for transfers.
 *
 * Which shape each write goes to is deliberate: every transition the legacy
 * vocabulary can express is still written THROUGH the legacy repository, which
 * mirrors it, so both shapes stay in step. Finalization is written to the unified
 * ledger alone, because there is no legacy column that could hold it.
 */
export async function reconcileEarnVaultMovements(env: Env): Promise<void> {
  const db = getDb(env);
  const repo = createPostgresEarnVaultRepository(db);
  const ledger = createPostgresEarnMovementsRepository(db);
  const movements = await ledger.claimUnsettledVaultMovements(OUTBOX_BATCH_SIZE);
  const byEnvironment = groupByEnvironment(movements);

  // Sequential on purpose. Each environment opens its own RPC client and polls a
  // batch of signature statuses, so running the handful of them together only
  // multiplies concurrent load on the endpoints for no measurable wall-clock win.
  for (const [environment, rows] of byEnvironment) {
    await reconcileEnvironment(env, repo, ledger, environment, rows);
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
  repo: ReturnType<typeof createPostgresEarnVaultRepository>,
  ledger: ReturnType<typeof createPostgresEarnMovementsRepository>,
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
      // Non-null for every vault_direct row by 0062's model-shape constraint;
      // the outbox scan only ever returns those.
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

  // Sequential on purpose, and load-bearing: an iteration can REBROADCAST a
  // transaction and writes CAS transitions, so fanning a 256-row batch out with
  // `Promise.all` would put 256 concurrent broadcasts on the RPC endpoint and 256
  // writes on the connection pool from one tick. Pacing is the point; the batch is
  // already bounded, and every other job in this directory reconciles the same way.
  for (const [index, movement] of rows.entries()) {
    try {
      await reconcileMovement(env, repo, ledger, movement, statuses[index] ?? null, {
        cluster,
        rpcUrl,
        currentBlockHeight,
      });
    } catch (error) {
      // Transport errors are ambiguous and stay retryable; a later tick
      // checks the recorded signature before rebroadcasting the same bytes.
      getLogger().error(
        { movementId: movement.id, signature: movement.signature, error },
        "earn vault reconciliation: movement remains unsettled"
      );
    }
  }
}

async function reconcileMovement(
  env: Env,
  repo: ReturnType<typeof createPostgresEarnVaultRepository>,
  ledger: ReturnType<typeof createPostgresEarnMovementsRepository>,
  movement: EarnMovementRow,
  status: SignatureStatusInfo | null,
  chain: { cluster: SolanaCluster; rpcUrl: string; currentBlockHeight: bigint | null }
): Promise<void> {
  if (status?.err) {
    await failMovement(repo, movement, JSON.stringify(status.err));
    return;
  }
  if (status?.confirmationStatus === "finalized") {
    // The end of the story, and the only outcome that cannot be rolled back.
    //
    // Record the commitment through the LEGACY writer first, even though this
    // observation is already stronger than that. `confirmed` is the most that
    // vocabulary can say, and writing it means a rollback to the previous
    // revision shows a settled deposit rather than one still in flight — the
    // legacy row is kept as close to the truth as it is able to get.
    if (movement.status !== "confirmed") {
      await repo.advanceMovement({
        movementId: movement.id,
        organizationId: movement.organization_id,
        fromStatuses: ["pending", "submitted"],
        toStatus: "confirmed",
        confirmedAt: new Date().toISOString(),
      });
    }
    await ledger.finalizeVaultMovement({
      movementId: movement.id,
      organizationId: movement.organization_id,
      settledAt: new Date().toISOString(),
    });
    return;
  }
  if (status?.confirmationStatus === "confirmed") {
    // Optimistic commitment. Recorded, and kept in the queue: a later tick asks
    // the chain again until it finalizes.
    if (movement.status === "confirmed") return;
    await repo.advanceMovement({
      movementId: movement.id,
      organizationId: movement.organization_id,
      fromStatuses: ["pending", "submitted"],
      toStatus: "confirmed",
      confirmedAt: new Date().toISOString(),
    });
    return;
  }
  if (status !== null) {
    await markSubmitted(repo, movement);
    return;
  }
  // A confirmed row whose signature has aged out of the RPC's history is NOT a
  // failure: the transaction demonstrably landed. Leave it for a later tick
  // rather than expiring it on the blockhash rule below, which only ever applied
  // to a transaction that never made it on chain.
  if (movement.status === "confirmed") return;

  // Nullable at the type level because `earn_movements` holds custodial rows too;
  // NOT NULL for every vault row by 0062's model-shape constraint, which is all
  // the outbox scan returns. Proven rather than coerced: rebroadcasting empty
  // bytes, or expiring a row against a missing block height, would both be
  // decisions made from a value that is not there.
  const { signed_transaction: signedTransaction, last_valid_block_height: lastValidBlockHeight } =
    movement;
  if (signedTransaction === null || lastValidBlockHeight === null) {
    throw new Error(
      `Earn vault movement ${movement.id} is missing the signed transaction it must be reconciled from`
    );
  }

  if (
    chain.currentBlockHeight !== null &&
    chain.currentBlockHeight > BigInt(lastValidBlockHeight)
  ) {
    await failMovement(repo, movement, "Transaction blockhash expired before confirmation");
    return;
  }
  if (chain.currentBlockHeight === null) return;

  await broadcastVaultTransaction(env, {
    cluster: chain.cluster,
    deadline: createVaultDeadline(),
    bytes: Uint8Array.from(Buffer.from(signedTransaction, "base64")),
    rpcUrl: chain.rpcUrl,
  });
  await markSubmitted(repo, movement);
}

async function markSubmitted(
  repo: ReturnType<typeof createPostgresEarnVaultRepository>,
  movement: EarnMovementRow
): Promise<void> {
  // `requested` is the ledger's word for the legacy `pending` this CAS guards on.
  if (movement.status !== "requested") return;
  await repo.advanceMovement({
    movementId: movement.id,
    organizationId: movement.organization_id,
    fromStatuses: ["pending"],
    toStatus: "submitted",
  });
}

async function failMovement(
  repo: ReturnType<typeof createPostgresEarnVaultRepository>,
  movement: EarnMovementRow,
  reason: string
): Promise<void> {
  await repo.advanceMovement({
    movementId: movement.id,
    organizationId: movement.organization_id,
    fromStatuses: ["pending", "submitted"],
    toStatus: "failed",
    failureReason: reason,
  });
}
