import { createRpc, getSignatureStatuses, type SignatureStatusInfo } from "@sdp/rpc/solana";
import type { SdpEnvironment, SolanaCluster } from "@sdp/types";
import type { Signature } from "@solana/kit";
import { getDb } from "@/db";
import {
  createPostgresEarnMovementsRepository,
  type EarnMovementRow,
  type EarnVaultWithdrawalLegRow,
} from "@/db/repositories/earn-movements.repository";
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
 * Every transition goes through the one ledger writer, and every legal source
 * state comes from the shared transition matrix — so a status this sweep cannot
 * legitimately reach is unrepresentable rather than merely unlikely.
 */
export async function reconcileEarnVaultMovements(env: Env): Promise<void> {
  const ledger = createPostgresEarnMovementsRepository(getDb(env));
  const [movements, withdrawalLegs] = await Promise.all([
    ledger.claimUnsettledVaultMovements(OUTBOX_BATCH_SIZE),
    ledger.claimUnsettledVaultWithdrawalLegs(OUTBOX_BATCH_SIZE),
  ]);
  const byEnvironment = groupByEnvironment([
    ...movements.map((movement) => ({ movement })),
    ...withdrawalLegs,
  ]);

  // Sequential on purpose. Each environment opens its own RPC client and polls a
  // batch of signature statuses, so running the handful of them together only
  // multiplies concurrent load on the endpoints for no measurable wall-clock win.
  for (const [environment, rows] of byEnvironment) {
    await reconcileEnvironment(env, ledger, environment, rows);
  }
}

type VaultReconciliationItem = {
  movement: EarnMovementRow;
  leg?: EarnVaultWithdrawalLegRow;
};

function groupByEnvironment(items: VaultReconciliationItem[]) {
  const byEnvironment = new Map<EarnMovementRow["environment"], VaultReconciliationItem[]>();
  for (const item of items) {
    const rows = byEnvironment.get(item.movement.environment);
    if (rows) rows.push(item);
    else byEnvironment.set(item.movement.environment, [item]);
  }
  return byEnvironment;
}

async function reconcileEnvironment(
  env: Env,
  ledger: ReturnType<typeof createPostgresEarnMovementsRepository>,
  environment: SdpEnvironment,
  rows: VaultReconciliationItem[]
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
      rows.map((row) => (row.leg?.signature ?? row.movement.signature) as Signature),
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
  for (const [index, item] of rows.entries()) {
    try {
      await reconcileMovement(env, ledger, item, statuses[index] ?? null, {
        cluster,
        rpcUrl,
        currentBlockHeight,
      });
    } catch (error) {
      // Transport errors are ambiguous and stay retryable; a later tick
      // checks the recorded signature before rebroadcasting the same bytes.
      getLogger().error(
        {
          movementId: item.movement.id,
          signature: item.leg?.signature ?? item.movement.signature,
          error,
        },
        "earn vault reconciliation: movement remains unsettled"
      );
    }
  }
}

async function reconcileMovement(
  env: Env,
  ledger: ReturnType<typeof createPostgresEarnMovementsRepository>,
  item: VaultReconciliationItem,
  status: SignatureStatusInfo | null,
  chain: { cluster: SolanaCluster; rpcUrl: string; currentBlockHeight: bigint | null }
): Promise<void> {
  const { movement, leg } = item;
  if (status?.err) {
    await failMovement(ledger, item, JSON.stringify(status.err));
    return;
  }
  if (status?.confirmationStatus === "finalized") {
    // The end of the story, and the only outcome that cannot be rolled back.
    // `confirmedAt` rides along because a movement whose FIRST observation is
    // already finalized never reported a separate commitment, and the ledger
    // requires the column for any settled row — the writer COALESCEs it, so a
    // movement that did report one keeps the moment it was actually observed.
    const observedAt = new Date().toISOString();
    await advanceTransaction(ledger, item, {
      toStatus: "finalized",
      confirmedAt: observedAt,
      settledAt: observedAt,
    });
    return;
  }
  if (status?.confirmationStatus === "confirmed") {
    // Optimistic commitment. Recorded, and kept in the queue: a later tick asks
    // the chain again until it finalizes.
    if ((leg?.status ?? movement.status) === "confirmed") return;
    await advanceTransaction(ledger, item, {
      toStatus: "confirmed",
      confirmedAt: new Date().toISOString(),
    });
    return;
  }
  if (status !== null) {
    await markSubmitted(ledger, item);
    return;
  }
  // A confirmed row whose signature has aged out of the RPC's history is NOT a
  // failure: the transaction demonstrably landed. Leave it for a later tick
  // rather than expiring it on the blockhash rule below, which only ever applied
  // to a transaction that never made it on chain.
  if ((leg?.status ?? movement.status) === "confirmed") return;

  // Nullable at the type level because `earn_movements` holds custodial rows too;
  // NOT NULL for every vault row by 0062's model-shape constraint, which is all
  // the outbox scan returns. Proven rather than coerced: rebroadcasting empty
  // bytes, or expiring a row against a missing block height, would both be
  // decisions made from a value that is not there.
  const signedTransaction = leg?.signed_transaction ?? movement.signed_transaction;
  const lastValidBlockHeight = leg?.last_valid_block_height ?? movement.last_valid_block_height;
  if (signedTransaction === null || lastValidBlockHeight === null) {
    throw new Error(
      `Earn vault movement ${movement.id} is missing the signed transaction it must be reconciled from`
    );
  }

  if (
    chain.currentBlockHeight !== null &&
    chain.currentBlockHeight > BigInt(lastValidBlockHeight)
  ) {
    await failMovement(ledger, item, "Transaction blockhash expired before confirmation");
    return;
  }
  if (chain.currentBlockHeight === null) return;

  // WITHDRAWAL LEG ORDERING (0066). A later leg's instructions may consume
  // state its predecessor creates, so a leg is (re)broadcast only after the
  // leg before it reached commitment — the same rule the request-path
  // submitter follows, applied here so a resumed group cannot land out of
  // order. A failed predecessor fails this leg too, because its instructions
  // were built against state that will now never exist; the shares it would
  // have redeemed remain in the wallet, immediately re-withdrawable. This gate
  // deliberately runs AFTER the expiry check — an expired leg can never land,
  // whatever its predecessor does.
  if (leg && leg.leg_index > 0) {
    const predecessor = await ledger.getVaultWithdrawalLegByIndex({
      movementId: movement.id,
      legIndex: leg.leg_index - 1,
    });
    if (!predecessor) {
      // 0066's leg-shape check and the group insert's atomicity make this
      // unreachable; loud, because broadcasting without the gate could land a
      // leg before its dependency.
      throw new Error(
        `Earn vault withdrawal leg ${movement.id} has no predecessor row to order against`
      );
    }
    if (predecessor.status === "failed") {
      await failMovement(
        ledger,
        item,
        `Predecessor withdrawal leg ${predecessor.signature} failed`
      );
      return;
    }
    if (predecessor.status !== "confirmed" && predecessor.status !== "finalized") {
      // Not this leg's turn yet. Leave it recorded; a later tick reconsiders
      // once the predecessor commits, fails, or expires.
      return;
    }
  }

  await broadcastVaultTransaction(env, {
    cluster: chain.cluster,
    deadline: createVaultDeadline(),
    bytes: Uint8Array.from(Buffer.from(signedTransaction, "base64")),
    rpcUrl: chain.rpcUrl,
  });
  await markSubmitted(ledger, item);
}

async function markSubmitted(
  ledger: ReturnType<typeof createPostgresEarnMovementsRepository>,
  item: VaultReconciliationItem
): Promise<void> {
  // Only an unbroadcast intent can become `submitted`; anything further along
  // would lose its CAS anyway, and skipping the round trip keeps the sweep quiet.
  if ((item.leg?.status ?? item.movement.status) !== "requested") return;
  await advanceTransaction(ledger, item, { toStatus: "submitted" });
}

async function failMovement(
  ledger: ReturnType<typeof createPostgresEarnMovementsRepository>,
  item: VaultReconciliationItem,
  reason: string
): Promise<void> {
  await advanceTransaction(ledger, item, { toStatus: "failed", failureReason: reason });
}

async function advanceTransaction(
  ledger: ReturnType<typeof createPostgresEarnMovementsRepository>,
  item: VaultReconciliationItem,
  change: {
    toStatus: string;
    failureReason?: string;
    confirmedAt?: string;
    settledAt?: string;
  }
): Promise<void> {
  if (item.leg) {
    await ledger.advanceVaultWithdrawalLeg({
      movementId: item.movement.id,
      legIndex: item.leg.leg_index,
      organizationId: item.movement.organization_id,
      ...change,
    });
    return;
  }
  await ledger.advanceVaultMovement({
    movementId: item.movement.id,
    organizationId: item.movement.organization_id,
    ...change,
  });
}
