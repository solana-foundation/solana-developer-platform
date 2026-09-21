import { supportsVaultProviderOrderWithdraw } from "@sdp/earn/capabilities";
import {
  createRpc,
  getSignatureStatuses,
  getTransaction,
  type SignatureStatusInfo,
  type SolanaRpc,
  tokenBalanceDelta,
} from "@sdp/rpc/solana";
import { compareDecimalAmounts, formatDecimalAmount, isDecimalString } from "@sdp/solana/amount";
import {
  EARN_TERMINAL_MOVEMENT_STATUSES,
  earnProviderDepositSettlement,
  type SdpEnvironment,
  type SolanaCluster,
} from "@sdp/types";
import type { Signature } from "@solana/kit";
import { getDb } from "@/db";
import {
  createPostgresEarnMovementsRepository,
  type EarnMovementRow,
  type EarnPositionRow,
} from "@/db/repositories/earn-movements.repository";
import { getLogger } from "@/runtime/logger";
import { describeError, logEvent } from "@/runtime/money-path-events";
import {
  assertClusterEndpoint,
  earnClusterFor,
  resolveClusterRpcUrl,
  resolveVaultDirectClient,
  resolveVaultWithdrawClient,
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
    rpc,
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
 * `failed` count transitions this tick ATTEMPTED, not steady state and not
 * transitions that provably landed: the ledger's guarded CAS decides that, and
 * `advanceTransaction` discards its result, so a row an overlapping tick or the
 * interactive read-through advanced first is still counted here. The read
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
        rpc,
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

interface ChainObservation {
  cluster: SolanaCluster;
  rpcUrl: string;
  rpc: SolanaRpc;
  currentBlockHeight: bigint | null;
}

async function reconcileMovement(
  env: Env,
  ledger: EarnMovementsLedger,
  movement: EarnMovementRow,
  status: SignatureStatusInfo | null,
  chain: ChainObservation
): Promise<MovementOutcome> {
  if (status?.err) {
    // The ledger keeps the readable sentence (it reaches the dashboard); the
    // chain's own variant goes to the log, where operators grep for it.
    const verdict = describeVaultSimulationError(status.err);
    getLogger().warn(
      { movementId: movement.id, signature: movement.signature, raw: verdict.raw },
      "earn movement failed on chain"
    );
    await failMovement(ledger, movement, verdict.message);
    return "failed";
  }
  if (status?.confirmationStatus === "finalized") {
    if (usesProviderOrderSettlement(env, movement)) {
      // The payment/share leg is irreversible, but Connect has not yet
      // reported that the subscription/redemption order settled. The current
      // ledger has no `awaiting_provider` state, so preserve the strongest
      // honest non-terminal fact it can express. In particular, never stamp
      // settled_at/token_amount_settled or close the position from this leg.
      // Parking also takes the row OUT of the sweep's claim set: no chain
      // read can advance it past `confirmed`, so re-reading it every tick
      // would be permanent reconciliation work for a fact the wire already
      // gave. A future Connect order reconciler must correlate and
      // authenticate provider completion before it advances one of these
      // rows beyond `confirmed`, and will bring its own scheduling.
      if (movement.status === "confirmed") return "unchanged";
      await advanceTransaction(ledger, movement, {
        toStatus: "confirmed",
        confirmedAt: new Date().toISOString(),
      });
      return "confirmed";
    }
    await settleMovement(env, ledger, movement, chain);
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
    // A `requested` row was never broadcast, so past its blockhash it genuinely
    // cannot land: expire it on the first observation. A `submitted` row is
    // different (PRO-1904): RPC history is not complete, and the `confirmed`
    // guard above exists for exactly that reason, so one null answer is not
    // proof the transaction did not land. Expiring a landed movement is a
    // terminal false `failed` with the shares sitting in the vault, so the
    // sweep parks the row on the first null observation and expires it only
    // when a LATER tick sees the signature unknown again. A tick that finds
    // the signature in between moves the row forward through the branches
    // above and the mark becomes inert.
    if (movement.status === "submitted" && movement.unknown_signature_observed_at === null) {
      await ledger.recordUnknownSignatureObservation({
        movementId: movement.id,
        organizationId: movement.organization_id,
      });
      return "unchanged";
    }
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

/**
 * Whether Solana finality records only the opening leg of a provider-managed
 * order rather than economic settlement.
 *
 * Deposits declare this in the shared provider table. Withdrawals declare it
 * on the executing client capability, so this guard follows the builder that
 * actually produced the transaction instead of inferring semantics from an id.
 * An unrecognized historical provider also stays non-terminal: atomicity is a
 * positive settlement claim and must never be inferred from registry drift.
 * A future Connect order reconciler must correlate and authenticate provider
 * completion before it advances one of these rows beyond `confirmed`.
 */
function usesProviderOrderSettlement(env: Env, movement: EarnMovementRow): boolean {
  if (movement.direction === "deposit") {
    return earnProviderDepositSettlement(movement.provider) === "provider_order";
  }
  const client = resolveVaultWithdrawClient(env, movement.provider, createVaultDeadline());
  return client === null || supportsVaultProviderOrderWithdraw(client);
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

/**
 * Finalize one movement and record what settlement means for the holding.
 *
 * Two settle-time observations ride the finalization (ADR 0002, the same shape
 * as the rent-funder residual): a withdrawal's token payout, read from the
 * landed transaction, and whether the holding is now EMPTY, read live from the
 * provider. Both are fail-soft. A payout that cannot be observed stays NULL
 * (the earnings read withholds `earned` rather than guessing) and a balance
 * that cannot be read leaves the position open; neither ever blocks the
 * finalization itself. Only the writer that wins the guarded CAS runs the
 * close check: a lost race means another observer finalized this row and is
 * running the same check.
 */
async function settleMovement(
  env: Env,
  ledger: EarnMovementsLedger,
  movement: EarnMovementRow,
  chain: ChainObservation
): Promise<void> {
  const position =
    movement.direction === "withdrawal"
      ? await ledger.getPositionById({
          organizationId: movement.organization_id,
          environment: movement.environment,
          positionId: movement.position_id,
        })
      : null;
  const tokenAmountSettled = position
    ? await observeWithdrawalPayout(chain.rpc, movement, position)
    : null;

  const observedAt = new Date().toISOString();
  const settled = await ledger.advanceVaultMovement({
    movementId: movement.id,
    organizationId: movement.organization_id,
    toStatus: "finalized",
    confirmedAt: observedAt,
    settledAt: observedAt,
    ...(movement.direction === "withdrawal" ? { tokenAmountSettled } : {}),
  });
  if (settled && position) {
    await closePositionIfEmpty(env, ledger, settled, position);
  }
}

/**
 * The wallet a withdrawal paid out to, as recorded at intent: the external
 * wallet on an owner-signed row, the custody wallet's public key on an
 * SDP-signed row (both write it as `destination_address`).
 */
function withdrawalReceiver(movement: EarnMovementRow): string | null {
  return movement.destination_address ?? movement.owner_address;
}

/**
 * A withdrawal's payout in the position's deposit token, observed as the
 * receiving wallet's post-minus-pre token balance in the landed transaction
 * and formatted at the mint's own decimals. Null whenever that cannot be
 * stated: no landed transaction, no token balances for the pair, a
 * non-positive delta, or an RPC failure. Never estimated.
 */
async function observeWithdrawalPayout(
  rpc: SolanaRpc,
  movement: EarnMovementRow,
  position: EarnPositionRow
): Promise<string | null> {
  const receiver = withdrawalReceiver(movement);
  const tokenMint = position.token_mint;
  if (!movement.signature || !receiver || !tokenMint) return null;
  try {
    const transaction = await getTransaction(rpc, movement.signature as Signature);
    if (!transaction || transaction.err !== null) return null;
    const delta = tokenBalanceDelta(transaction, { mint: tokenMint, owner: receiver });
    if (!delta || delta.baseUnits <= 0n) return null;
    return formatDecimalAmount(delta.baseUnits, delta.decimals);
  } catch (error) {
    getLogger().warn(
      { movementId: movement.id, signature: movement.signature, error: errorMessage(error) },
      "earn vault reconciliation: withdrawal payout not observed"
    );
    return null;
  }
}

/**
 * After a finalized withdrawal, read the holding's live balance for exactly
 * this vault and owner and stamp `closed_at` when it is zero. The same identity
 * checks the position hydration applies (owner, cluster, vault, both mints)
 * guard the read, so a foreign snapshot can never close somebody's position.
 * Fail-soft: an unreadable balance leaves the row open for a later settlement.
 */
async function closePositionIfEmpty(
  env: Env,
  ledger: EarnMovementsLedger,
  movement: EarnMovementRow,
  position: EarnPositionRow
): Promise<void> {
  const owner = position.owner_address ?? withdrawalReceiver(movement);
  const vault = position.vault_address;
  if (!owner || !vault || !position.token_mint || !position.share_mint) return;
  try {
    const client = resolveVaultDirectClient(env, movement.provider, createVaultDeadline());
    if (!client) return;
    const snapshots = await client.readVaultPositions(
      { env, environment: movement.environment },
      { owner, providerReferences: [vault] }
    );
    const snapshot = snapshots.find(
      (candidate) =>
        candidate.providerReference === vault &&
        candidate.owner === owner &&
        candidate.cluster === earnClusterFor(movement.environment) &&
        candidate.tokenMint === position.token_mint &&
        candidate.shareMint === position.share_mint
    );
    if (
      !snapshot ||
      !isDecimalString(snapshot.shares) ||
      compareDecimalAmounts(snapshot.shares, "0") !== 0
    ) {
      return;
    }
    // `position` was read before the payout observation and the finalize, so
    // its `updated_at` bounds this close: a deposit that landed since bumped it
    // and the repository refuses the stale snapshot.
    await ledger.closeVaultPositionIfEmpty({
      positionId: position.id,
      organizationId: movement.organization_id,
      observedUpdatedAt: position.updated_at,
    });
  } catch (error) {
    getLogger().warn(
      { movementId: movement.id, positionId: position.id, error: errorMessage(error) },
      "earn vault reconciliation: post-exit balance not observed"
    );
  }
}

/** How far back the payout repair looks: RPC transaction history is finite. */
export const WITHDRAWAL_PAYOUT_REPAIR_WINDOW_MS = 14 * 24 * 60 * 60 * 1_000;
/** Minimum spacing between two repair attempts on the same movement. */
export const WITHDRAWAL_PAYOUT_REPAIR_RETRY_MS = 15 * 60 * 1_000;
const WITHDRAWAL_PAYOUT_REPAIR_BATCH_SIZE = 25;

export interface WithdrawalPayoutRepairStats {
  claimed: number;
  repaired: number;
  /** Claimed rows whose payout still could not be observed; retried later. */
  unobserved: number;
  /** Rows whose repair threw (database or lookup failure), counted as tick failures. */
  errors: number;
}

/**
 * Second chance for a withdrawal payout the settlement could not observe.
 *
 * `settleMovement` finalizes a withdrawal even when `getTransaction` fails,
 * because the chain outcome is known and finalization must not wait on a
 * flaky history read. Without this pass that one failed read would leave
 * `token_amount_settled` NULL forever: `totalWithdrawn` understated and
 * `earned` withheld as `withdrawals_not_valued`. Runs every sweep tick over a
 * bounded, retry-spaced claim of unvalued finalized withdrawals inside the RPC
 * history window; a row older than the window stays NULL and keeps reporting
 * the honest reason. Idempotent by construction: the write refuses a row that
 * is already valued.
 */
export async function repairUnvaluedWithdrawalPayouts(
  env: Env,
  {
    limit = WITHDRAWAL_PAYOUT_REPAIR_BATCH_SIZE,
    now = Date.now(),
  }: { limit?: number; now?: number } = {}
): Promise<WithdrawalPayoutRepairStats> {
  const ledger = createPostgresEarnMovementsRepository(getDb(env));
  const movements = await ledger.claimUnvaluedWithdrawalPayouts({
    limit,
    settledAfter: new Date(now - WITHDRAWAL_PAYOUT_REPAIR_WINDOW_MS).toISOString(),
    retryBefore: new Date(now - WITHDRAWAL_PAYOUT_REPAIR_RETRY_MS).toISOString(),
  });
  const stats: WithdrawalPayoutRepairStats = {
    claimed: movements.length,
    repaired: 0,
    unobserved: 0,
    errors: 0,
  };
  for (const [environment, rows] of groupByEnvironment(movements)) {
    const rpc = createRpc(env, { rpcUrl: resolveClusterRpcUrl(env, earnClusterFor(environment)) });
    for (const movement of rows) {
      try {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- reconciliation pacing is intentional.
        const position = await ledger.getPositionById({
          organizationId: movement.organization_id,
          environment: movement.environment,
          positionId: movement.position_id,
        });
        const payout = position ? await observeWithdrawalPayout(rpc, movement, position) : null;
        if (payout === null) {
          stats.unobserved += 1;
          continue;
        }
        const recorded = await ledger.recordWithdrawalPayout({
          movementId: movement.id,
          organizationId: movement.organization_id,
          tokenAmountSettled: payout,
        });
        if (recorded) stats.repaired += 1;
      } catch (error) {
        stats.errors += 1;
        getLogger().error(
          { movementId: movement.id, error: errorMessage(error) },
          "earn vault reconciliation: withdrawal payout repair failed"
        );
      }
    }
  }
  return stats;
}
