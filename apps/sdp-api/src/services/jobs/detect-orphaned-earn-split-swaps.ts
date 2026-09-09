import { createRpc } from "@sdp/rpc/solana";
import type { SdpEnvironment } from "@sdp/types";
import { getDb } from "@/db";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import { createPostgresEarnMovementsRepository } from "@/db/repositories/earn-movements.repository";
import {
  createPostgresEarnSplitSwapAdvisoriesRepository,
  type EarnSplitSwapAdvisoryRow,
} from "@/db/repositories/earn-split-swap-advisories.repository";
import { describeError, logEvent } from "@/runtime/money-path-events";
import {
  assertClusterEndpoint,
  earnClusterFor,
  resolveClusterRpcUrl,
} from "@/services/earn/execution-registry";
import { readOwnerMintBalance } from "@/services/earn/owner-token-balance";
import type { Env } from "@/types/env";

/**
 * Orphaned split-swap detection (PRO-1864, threat model EARN-026).
 *
 * A split swap-funded deposit hands the partner a standalone swap to broadcast
 * itself. If the swap lands and the follow-up deposit never comes, the
 * customer's funds sit swapped-but-undeposited in their own wallet and nothing
 * in the movement ledger knows. This sweep reads the advisories the build
 * recorded and judges each one against the chain. It ALERTS and never acts:
 * the funds are the owner's, in the owner's account, and the only party who
 * can move them is the partner.
 *
 * The judgement, in order, per open advisory:
 *
 * 1. A follow-up DEPOSIT MOVEMENT for the same owner and deposit token, created
 *    after the advisory, that reached `confirmed`/`finalized` -> resolved
 *    `deposit_observed`. Status matters: a `failed` deposit did not move the
 *    money, and a still-`requested` one is in flight, not observed. One
 *    movement discharges at most one advisory (UNIQUE resolving_movement_id),
 *    so a reused owner wallet cannot close several with one deposit.
 * 2. A follow-up BUILD within the window, or an in-flight movement -> pending.
 *    A build proves the partner is alive and past the swap; the movement only
 *    exists once they submit, and a human second signature can take minutes.
 * 3. The swap's blockhash still live, or the advisory younger than the grace
 *    period -> pending. Past its last valid block height the swap either landed
 *    or never will, which is when a balance means something.
 * 4. Otherwise the owner's deposit-token balance is read on the environment's
 *    cluster with the same call the build's baseline used. The swap enforces
 *    `minOut` on chain, so a landed swap raised the balance by at least
 *    `swap_min_out_atoms`: that delta is ORPHANED and is reported every visit
 *    while it persists. No rise at all is `unfunded` (the swap never broadcast,
 *    or the owner moved the tokens; nothing sits swapped-but-undeposited). A
 *    partial rise is indeterminate and stays open for the next visit.
 *
 * Failure posture matches the vault-movement sweep: a chain read that fails is
 * counted, emits its own error event, marks the tick error-level and THROWS so
 * `sdp_cron_run` records error. The job's own database queries failing emit no
 * tick at all: a fabricated tick with zero counts would read as a healthy sweep.
 */

const BATCH_SIZE = 128;
/** The partner's follow-up needs a rebuild, a second signature and a submit. */
const GRACE_MS = 30 * 60_000;
/** A follow-up build newer than this is taken as the partner still working. */
const FOLLOW_UP_WINDOW_MS = 30 * 60_000;
/** Orphans older than this are escalated so the alert rule can key on it. */
const ESCALATE_AFTER_MS = 60 * 60_000;

const OBSERVED_STATUSES = new Set(["confirmed", "finalized"]);
const IN_FLIGHT_STATUSES = new Set(["requested", "submitted"]);

export interface EarnSplitSwapDetectionStats {
  checked: number;
  depositObserved: number;
  followUpPending: number;
  pending: number;
  orphaned: number;
  indeterminate: number;
  unfunded: number;
  balanceReadFailures: number;
  blockHeightReadFailures: number;
}

export async function detectOrphanedEarnSplitSwaps(
  env: Env,
  options: { now?: () => number } = {}
): Promise<void> {
  const now = options.now ?? (() => Date.now());
  const db = getDb(env);
  const advisories = createPostgresEarnSplitSwapAdvisoriesRepository(db);
  const ledger = createPostgresEarnMovementsRepository(db);

  const batch = await advisories.claimOpenForDetection(BATCH_SIZE);
  const stats: EarnSplitSwapDetectionStats = {
    checked: batch.length,
    depositObserved: 0,
    followUpPending: 0,
    pending: 0,
    orphaned: 0,
    indeterminate: 0,
    unfunded: 0,
    balanceReadFailures: 0,
    blockHeightReadFailures: 0,
  };

  // One block height per environment, read once for the whole batch so every
  // advisory in a tick is judged against the same moment on its own cluster.
  const byEnvironment = new Map<SdpEnvironment, EarnSplitSwapAdvisoryRow[]>();
  for (const advisory of batch) {
    const rows = byEnvironment.get(advisory.environment);
    if (rows) rows.push(advisory);
    else byEnvironment.set(advisory.environment, [advisory]);
  }

  for (const [environment, rows] of byEnvironment) {
    let blockHeight: bigint | null = null;
    try {
      const cluster = earnClusterFor(environment);
      const rpcUrl = resolveClusterRpcUrl(env, cluster);
      await assertClusterEndpoint(env, cluster, rpcUrl);
      blockHeight = await createRpc(env, { rpcUrl })
        .getBlockHeight({ commitment: "confirmed" })
        .send();
    } catch (error) {
      logEvent("error", {
        event: "sdp_api_earn_split_swap_block_height_read_failed",
        environment,
        rows: rows.length,
        ...describeError(error),
        error_message: errorMessage(error),
      });
      stats.blockHeightReadFailures += 1;
    }

    for (const advisory of rows) {
      // Sequential on purpose: one filtered RPC read per judged advisory.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- pacing is intentional.
      await judgeAdvisory(env, advisories, ledger, advisory, blockHeight, now(), stats);
    }
  }

  const openBacklog = await advisories.countOpen();
  const failures = stats.balanceReadFailures + stats.blockHeightReadFailures;
  logEvent(failures > 0 ? "error" : "info", {
    event: "sdp_api_earn_split_swap_detection_tick",
    checked: stats.checked,
    deposit_observed: stats.depositObserved,
    follow_up_pending: stats.followUpPending,
    pending: stats.pending,
    orphaned: stats.orphaned,
    indeterminate: stats.indeterminate,
    unfunded: stats.unfunded,
    balance_read_failures: stats.balanceReadFailures,
    block_height_read_failures: stats.blockHeightReadFailures,
    open_backlog: openBacklog,
    batch_saturated: batch.length === BATCH_SIZE,
  });

  if (failures > 0) {
    throw new Error(
      `Earn split-swap detection could not read chain state ` +
        `(${stats.blockHeightReadFailures} block-height, ${stats.balanceReadFailures} balance failures) ` +
        `over ${stats.checked} advisories`
    );
  }
}

async function judgeAdvisory(
  env: Env,
  advisories: ReturnType<typeof createPostgresEarnSplitSwapAdvisoriesRepository>,
  ledger: ReturnType<typeof createPostgresEarnMovementsRepository>,
  advisory: EarnSplitSwapAdvisoryRow,
  blockHeight: bigint | null,
  nowMs: number,
  stats: EarnSplitSwapDetectionStats
): Promise<void> {
  const scope = {
    organizationId: advisory.organization_id,
    projectId: advisory.project_id,
    environment: advisory.environment,
    ownerAddress: advisory.owner_address,
    depositTokenMint: advisory.deposit_token_mint,
    createdAfter: advisory.created_at,
  };

  // 1. A follow-up deposit that reached chain commitment discharges the advisory.
  const deposits = await ledger.listExternalWalletDepositsSince(scope);
  for (const movement of deposits.filter((row) => OBSERVED_STATUSES.has(row.status))) {
    try {
      const resolved = await advisories.resolve({
        advisoryId: advisory.id,
        resolution: "deposit_observed",
        resolvedBy: "system",
        resolvingMovementId: movement.id,
      });
      if (resolved) {
        stats.depositObserved += 1;
        return;
      }
    } catch (error) {
      // Another advisory for this owner already claimed this movement: one
      // deposit discharges exactly one advisory. Try the next candidate.
      if (!isPostgresUniqueViolation(error)) throw error;
    }
  }

  // 2. The partner is demonstrably still working: a deposit in flight, or a
  //    recent follow-up build.
  if (deposits.some((row) => IN_FLIGHT_STATUSES.has(row.status))) {
    stats.followUpPending += 1;
    await advisories.recordObservation({
      advisoryId: advisory.id,
      observedAtoms: null,
      followUpBuildAt: null,
      flagged: false,
    });
    return;
  }
  const followUpBuildAt = await advisories.findFollowUpBuildAt(scope);
  if (followUpBuildAt !== null && nowMs - Date.parse(followUpBuildAt) < FOLLOW_UP_WINDOW_MS) {
    stats.followUpPending += 1;
    await advisories.recordObservation({
      advisoryId: advisory.id,
      observedAtoms: null,
      followUpBuildAt,
      flagged: false,
    });
    return;
  }

  // 3. Too early to judge: the swap can still land, or the grace has not run.
  const ageMs = nowMs - Date.parse(advisory.created_at);
  if (
    blockHeight === null ||
    blockHeight <= BigInt(advisory.swap_last_valid_block_height) ||
    ageMs < GRACE_MS
  ) {
    stats.pending += 1;
    return;
  }

  // 4. Judge the owner's deposit-token balance against the build-time baseline.
  let balance: Awaited<ReturnType<typeof readOwnerMintBalance>>;
  try {
    balance = await readOwnerMintBalance(
      env,
      advisory.environment,
      advisory.owner_address,
      advisory.deposit_token_mint
    );
  } catch (error) {
    stats.balanceReadFailures += 1;
    logEvent("error", {
      event: "sdp_api_earn_split_swap_balance_read_failed",
      advisory_id: advisory.id,
      environment: advisory.environment,
      owner_address: advisory.owner_address,
      deposit_token_mint: advisory.deposit_token_mint,
      ...describeError(error),
      error_message: errorMessage(error),
    });
    return;
  }
  if (balance.decimals !== null && balance.decimals !== advisory.deposit_token_decimals) {
    // Atoms of a different scale cannot be compared; refuse to judge rather
    // than misjudge, and make it loud.
    stats.balanceReadFailures += 1;
    logEvent("error", {
      event: "sdp_api_earn_split_swap_balance_read_failed",
      advisory_id: advisory.id,
      environment: advisory.environment,
      owner_address: advisory.owner_address,
      deposit_token_mint: advisory.deposit_token_mint,
      error_name: "DecimalsMismatch",
      error_message: `chain reports ${balance.decimals} decimals, advisory recorded ${advisory.deposit_token_decimals}`,
    });
    return;
  }

  const observedAtoms = balance.atoms.toString();
  const delta = balance.atoms - BigInt(advisory.baseline_deposit_token_atoms);
  const floor = BigInt(advisory.swap_min_out_atoms);

  if (delta >= floor) {
    stats.orphaned += 1;
    await advisories.recordObservation({
      advisoryId: advisory.id,
      observedAtoms,
      followUpBuildAt,
      flagged: true,
    });
    // "warn", not "error": this is a partner-side funds condition, not SDP
    // machinery failing. `escalated` is what the paging rule keys on.
    logEvent("warn", {
      event: "sdp_api_earn_split_swap_orphaned",
      advisory_id: advisory.id,
      organization_id: advisory.organization_id,
      project_id: advisory.project_id,
      environment: advisory.environment,
      provider: advisory.provider,
      strategy_id: advisory.strategy_id,
      vault_address: advisory.vault_address,
      owner_address: advisory.owner_address,
      deposit_token_mint: advisory.deposit_token_mint,
      deposit_token_decimals: advisory.deposit_token_decimals,
      swap_min_out_atoms: advisory.swap_min_out_atoms,
      swap_min_out_amount: advisory.swap_min_out_amount,
      baseline_atoms: advisory.baseline_deposit_token_atoms,
      observed_atoms: observedAtoms,
      delta_atoms: delta.toString(),
      age_seconds: Math.round(ageMs / 1000),
      escalated: ageMs >= ESCALATE_AFTER_MS,
      first_flagged_at: advisory.first_flagged_at,
      last_follow_up_build_at: followUpBuildAt ?? advisory.last_follow_up_build_at,
    });
    return;
  }

  if (delta <= 0n) {
    stats.unfunded += 1;
    await advisories.resolve({
      advisoryId: advisory.id,
      resolution: "unfunded",
      resolvedBy: "system",
      observedAtoms,
    });
    return;
  }

  // A partial rise: the owner spent or moved part of it, or something else
  // credited the account. Not provably an orphan, not provably clean; revisit.
  stats.indeterminate += 1;
  await advisories.recordObservation({
    advisoryId: advisory.id,
    observedAtoms,
    followUpBuildAt,
    flagged: false,
  });
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
