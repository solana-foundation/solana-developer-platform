import { createRpc, getSignatureStatuses, type SignatureStatusInfo } from "@sdp/rpc/solana";
import type { SdpEnvironment, SolanaCluster } from "@sdp/types";
import type { Signature } from "@solana/kit";
import { getDb } from "@/db";
import {
  createPostgresEarnVaultRepository,
  type EarnVaultMovementRow,
} from "@/db/repositories/earn-vault.repository";
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

/** Reconcile every recorded signed vault transaction to a terminal outcome. */
export async function reconcileEarnVaultMovements(env: Env): Promise<void> {
  const repo = createPostgresEarnVaultRepository(getDb(env));
  const movements = await repo.listUnsettledMovements(OUTBOX_BATCH_SIZE);
  const byEnvironment = groupByEnvironment(movements);

  for (const [environment, rows] of byEnvironment) {
    await reconcileEnvironment(env, repo, environment, rows);
  }
}

function groupByEnvironment(movements: EarnVaultMovementRow[]) {
  const byEnvironment = new Map<EarnVaultMovementRow["environment"], EarnVaultMovementRow[]>();
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
  environment: SdpEnvironment,
  rows: EarnVaultMovementRow[]
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

  for (const [index, movement] of rows.entries()) {
    try {
      await reconcileMovement(env, repo, movement, statuses[index] ?? null, {
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
  movement: EarnVaultMovementRow,
  status: SignatureStatusInfo | null,
  chain: { cluster: SolanaCluster; rpcUrl: string; currentBlockHeight: bigint | null }
): Promise<void> {
  if (status?.err) {
    await failMovement(repo, movement, JSON.stringify(status.err));
    return;
  }
  if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
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
  if (
    chain.currentBlockHeight !== null &&
    chain.currentBlockHeight > BigInt(movement.last_valid_block_height)
  ) {
    await failMovement(repo, movement, "Transaction blockhash expired before confirmation");
    return;
  }
  if (chain.currentBlockHeight === null) return;

  await broadcastVaultTransaction(env, {
    cluster: chain.cluster,
    deadline: createVaultDeadline(),
    bytes: Uint8Array.from(Buffer.from(movement.signed_transaction, "base64")),
    rpcUrl: chain.rpcUrl,
  });
  await markSubmitted(repo, movement);
}

async function markSubmitted(
  repo: ReturnType<typeof createPostgresEarnVaultRepository>,
  movement: EarnVaultMovementRow
): Promise<void> {
  if (movement.status !== "pending") return;
  await repo.advanceMovement({
    movementId: movement.id,
    organizationId: movement.organization_id,
    fromStatuses: ["pending"],
    toStatus: "submitted",
  });
}

async function failMovement(
  repo: ReturnType<typeof createPostgresEarnVaultRepository>,
  movement: EarnVaultMovementRow,
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
