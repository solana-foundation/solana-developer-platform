/**
 * Background Job: Track Pending Private Channel Withdrawals
 *
 * State machine: pending → submitted → confirmed → settled (terminal) | failed.
 *
 * Reconciles non-terminal withdrawals each cron tick:
 *  1. `pending` with no burn signature, stuck > 5 min → failed (never broadcast).
 *  2. `submitted` with a burn signature → getSignatureStatuses on the CURRENT
 *     instance gateway → `confirmed` / `failed`; signature not found + stale →
 *     failed. This is the ONLY window where a withdrawal can auto-`failed`
 *     (pre-burn-confirmation — no balance moved yet). Status reads are batched
 *     per tick: every submitted burn targeting the same gateway rides a single
 *     getSignatureStatuses call instead of one RPC round trip per row.
 *  3. `confirmed` → `settled` via the polling oracle: walk the CURRENT
 *     instance's escrow ATA on devnet backwards through address history for
 *     outgoing SPL transfers matching a withdrawal's (destinationAta, mint,
 *     baseUnits), CLAIM the match by inserting into
 *     `private_channel_settlement_observations` (UNIQUE guards against
 *     double-claim + racing pollers), then CAS-advance the withdrawal to
 *     `settled` with `settlement_ref = signature`. Stale unmatched → operator
 *     `TRANSFER_STUCK_WARNING` (debounced via `context.lastStuckWarningAt`),
 *     never auto-`failed` — the balance is already burned.
 *
 *     The walk pages backwards with `before` instead of reading one fixed
 *     newest page (SOLA9-157): a permissionless payer can fill the newest page
 *     with transactions that merely reference the escrow ATA, which would
 *     otherwise evict a real release from every scan. Each (instance, mint)
 *     group persists where it has reached in `private_channel_release_scans`:
 *     a parsed frontier (the cursor — everything at or behind it was fully
 *     parsed and matched; it never moves to an older slot and advances within
 *     a slot only from the cursor the tick read) and, when a
 *     walk hit the page cap before reaching the frontier, the deepest listed
 *     signature (the sweep — a later tick resumes listing below it instead of
 *     re-reading the same newest band forever). Progress therefore accumulates
 *     across ticks and a release cannot be pushed permanently out of reach,
 *     however deep the spam backlog. Before the first cursor exists the walk
 *     is bounded below by the oldest unsettled withdrawal's `created_at` (a
 *     release always postdates the intent's creation), with a clock-skew
 *     margin. A walk that hits the page cap still parses the newest
 *     candidates but does not advance the cursor — the unexplored region below
 *     stays due, the sweep position is persisted, and the tick logs a warning.
 *
 * The release reconciler resolves the project's CURRENT RPC connection each
 * tick, so provider changes and credential rotations apply to in-flight intents.
 * The audit context on each withdrawal is never consulted here.
 *
 * All status transitions are compare-and-swap (`expectedStatus`) so a concurrent
 * worker can't regress state. Release attribution is by content
 * `(destinationAta, mint, base-unit amount)`, FIFO within the single-flight
 * bucket, so it cannot disambiguate two withdrawals sharing all three; a
 * memo/withdrawId on the release tx would make it exact.
 */

import * as solanaRpc from "@sdp/rpc/solana";
import { parseDecimalAmount } from "@sdp/solana/amount";
import { PRIVATE_CHANNEL_EVENT_TYPES } from "@sdp/types";
import { type Address, address, type Signature } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  createPrivateChannelInstanceRepository,
  createPrivateChannelReleaseScanRepository,
  createPrivateChannelSettlementObservationRepository,
  createPrivateChannelWithdrawalRepository,
  type PrivateChannelInstanceRow,
  type PrivateChannelReleaseScanCursor,
  type PrivateChannelReleaseScanRepository,
  type PrivateChannelSettlementObservationRepository,
  type PrivateChannelWithdrawalRepository,
  type PrivateChannelWithdrawalRow,
} from "@/db/repositories";
import { mapSettledWithConcurrency } from "@/lib/concurrency";
import { getLogger } from "@/runtime/logger";
import { knownMintToken } from "@/services/private-channels/mint";
import {
  loadProjectRpcClient,
  type PrivateChannelProjectRpcClient,
} from "@/services/private-channels/project-rpc";
import { describeTransactionErr } from "@/services/private-channels/tx-error";
import { emitWithdrawalEvent } from "@/services/private-channels/withdraw-events";
import type { Env } from "@/types/env";

const STUCK_AFTER_MS = 5 * 60 * 1000;
/** How long to wait for the operator's devnet release before pinging the operator. */
const RELEASE_STUCK_AFTER_MS = 30 * 60 * 1000;
/** Rate-limit the stuck-warning event: at most once per hour per withdrawal. */
const STUCK_WARNING_INTERVAL_MS = 60 * 60 * 1000;
const MAX_PER_RUN = 100;
/** Signatures per getSignaturesForAddress page while walking escrow history (RPC max). */
const RELEASE_SCAN_PAGE_LIMIT = 1000;
/**
 * Page-fetch cap per (instance, mint) group per tick. A walk that stops here
 * could not reach the cursor, the created_at bound, or history's end, so its
 * window is not provably contiguous with the parsed region: it still parses
 * (budget-capped) but never advances the cursor. Caps the list-call cost of
 * one tick against a flooded escrow ATA.
 */
const RELEASE_SCAN_MAX_PAGES = 20;
/**
 * Page-fetch cap for the tip band while a sweep is pending (backlog mode).
 * Every new entry passes through the newest band on arrival, so this stays
 * the fresh-release window; the rest of the page budget goes to resuming the
 * deep sweep below the persisted position.
 */
const RELEASE_SCAN_TIP_PAGES = 2;
/**
 * getTransaction lookups per (instance, mint) group per tick. Parsing is
 * bounded independently of how much history the walk listed, so a flood of
 * referencing transactions cannot scale the reconciler's paid-RPC work.
 */
const RELEASE_PARSE_BUDGET = 300;
/**
 * Clock-skew margin on the created_at lower bound for a cursor-less first
 * scan. Only skew needs covering: a release always postdates the intent's
 * creation by flow, so anything older is not this batch's release.
 */
const RELEASE_SCAN_TIME_MARGIN_MS = 2 * 60 * 60 * 1000;
/** Bound concurrent getTransaction lookups while parsing release candidates. */
const RELEASE_LOOKUP_CONCURRENCY = 5;

export async function trackPendingWithdrawals(env: Env): Promise<void> {
  const repo = createPrivateChannelWithdrawalRepository(env);
  const instanceRepo = createPrivateChannelInstanceRepository(env);
  const observationRepo = createPrivateChannelSettlementObservationRepository(env);
  const releaseScanRepo = createPrivateChannelReleaseScanRepository(env);
  const pending = await repo.listNonTerminal(MAX_PER_RUN);
  if (pending.length === 0) {
    return;
  }

  const instances = new Map<string, PrivateChannelInstanceRow | null>();
  const projectRpcs = new Map<string, Promise<PrivateChannelProjectRpcClient>>();
  const loadInstance = async (id: string) => {
    if (instances.has(id)) {
      return instances.get(id) ?? null;
    }
    const row = await instanceRepo.getById(id);
    instances.set(id, row);
    return row;
  };
  const loadProjectRpc = (instance: PrivateChannelInstanceRow) => {
    const key = `${instance.organization_id}:${instance.project_id}`;
    const cached = projectRpcs.get(key);
    if (cached) return cached;
    const loaded = loadProjectRpcClient({
      env,
      organizationId: instance.organization_id,
      projectId: instance.project_id,
    });
    projectRpcs.set(key, loaded);
    return loaded;
  };

  const now = Date.now();

  // One RPC client per gateway URL per tick, shared by every withdrawal that
  // burns on the same gateway.
  const gatewayRpcs = new Map<string, solanaRpc.SolanaRpc>();
  const gatewayRpcFor = (instance: PrivateChannelInstanceRow): solanaRpc.SolanaRpc => {
    let rpc = gatewayRpcs.get(instance.gateway_url);
    if (!rpc) {
      rpc = solanaRpc.createRpc(env, { rpcUrl: instance.gateway_url });
      gatewayRpcs.set(instance.gateway_url, rpc);
    }
    return rpc;
  };

  // Submitted withdrawals bucketed by gateway: every burn signature on the same
  // gateway shares one batched getSignatureStatuses call per tick instead of
  // paying one RPC round trip per row. Buckets stay well under the RPC's
  // 256-signature cap because MAX_PER_RUN bounds the whole tick.
  const buckets = new Map<
    string,
    { rpc: solanaRpc.SolanaRpc; withdrawals: PrivateChannelWithdrawalRow[] }
  >();

  const reconcileSubmitted = (
    withdrawal: PrivateChannelWithdrawalRow,
    instance: PrivateChannelInstanceRow
  ): Promise<void> => {
    if (!withdrawal.signature) {
      return failIfStale(
        env,
        repo,
        withdrawal,
        now,
        "Withdrawal was submitted without a signature."
      );
    }
    let bucket = buckets.get(instance.gateway_url);
    if (!bucket) {
      bucket = { rpc: gatewayRpcFor(instance), withdrawals: [] };
      buckets.set(instance.gateway_url, bucket);
    }
    bucket.withdrawals.push(withdrawal);
    return Promise.resolve();
  };

  // Phase 1 — local transitions (stale fails, CAS promotions) and bucketing; no
  // per-row RPC.
  for (const withdrawal of pending) {
    try {
      if (withdrawal.status === "pending" && !withdrawal.signature) {
        await failIfStale(env, repo, withdrawal, now, "Withdrawal burn was never broadcast.");
      } else if (withdrawal.status === "pending") {
        await promoteSignedPending(repo, withdrawal, loadInstance, reconcileSubmitted, now);
      } else if (withdrawal.status === "submitted") {
        const instance = await loadInstance(withdrawal.instance_id);
        if (!instance) {
          // No instance to reconcile against; pre-burn-confirmation, so `failed`
          // is legitimate. Only auto-fail past the stale window.
          await failStale(env, repo, withdrawal, now, "Withdrawal instance no longer connected.");
          continue;
        }
        await reconcileSubmitted(withdrawal, instance);
      }
      // `confirmed` handled by the release-observation pass below.
    } catch (err) {
      logReconcileError(withdrawal.id, withdrawal.status, err);
    }
  }

  // Phase 1b — one batched burn-status read per gateway, then per-row verdicts.
  await Promise.all(
    [...buckets.values()].map(async (bucket) => {
      let statuses: Array<solanaRpc.SignatureStatusInfo | null>;
      try {
        // Burn is on the gateway (channel chain). No auth here — auth-enabled
        // instances will need to be wired through this call the way
        // withdraw-confirm.ts does.
        // TODO(auth): plumb resolveMemberGatewayAuth into the cron path once we need it.
        // searchTransactionHistory for the same reason as the deposit reconciler:
        // every path into here is already past the node's short recent-status cache,
        // and promoteSignedPending reaches it strictly AFTER STUCK_AFTER_MS. Without
        // it an executed burn reads null and is failed, which invites the caller to
        // burn the same balance twice.
        statuses = await solanaRpc.getSignatureStatuses(
          bucket.rpc,
          bucket.withdrawals.map((withdrawal) => withdrawal.signature as Signature),
          { searchTransactionHistory: true }
        );
      } catch (err) {
        getLogger().error(
          {
            withdrawals: bucket.withdrawals.length,
            error: err instanceof Error ? err.message : String(err),
          },
          "trackPendingWithdrawals: batched getSignatureStatuses failed"
        );
        return;
      }
      if (statuses.length !== bucket.withdrawals.length) {
        getLogger().error(
          { withdrawals: bucket.withdrawals.length, statuses: statuses.length },
          "trackPendingWithdrawals: getSignatureStatuses returned a mismatched batch"
        );
        return;
      }
      for (const [index, withdrawal] of bucket.withdrawals.entries()) {
        try {
          await applySubmittedVerdict(env, repo, withdrawal, statuses[index] ?? null, now);
        } catch (err) {
          logReconcileError(withdrawal.id, "submitted", err);
        }
      }
    })
  );

  // Phase 2 — `confirmed` → `settled` via release-observation scan. Grouped by
  // (instance, mint) so the escrow ATA's signatures are fetched once per bucket.
  const groups = new Map<string, ReleaseGroup>();
  for (const withdrawal of pending) {
    if (withdrawal.status !== "confirmed") {
      continue;
    }
    const instance = await loadInstance(withdrawal.instance_id);
    if (!instance) {
      // Same rationale as above; no chain to observe. Stuck-warning wouldn't
      // help either — no operator dashboard for a disconnected instance.
      continue;
    }
    const key = releaseGroupKey(instance, withdrawal);
    const existing = groups.get(key);
    if (existing) {
      existing.withdrawals.push(withdrawal);
    } else {
      groups.set(key, { instance, mint: withdrawal.mint, withdrawals: [withdrawal] });
    }
  }

  await Promise.all(
    [...groups.values()].map(async (group) => {
      try {
        await reconcileReleaseGroup(
          env,
          repo,
          observationRepo,
          releaseScanRepo,
          group,
          await loadProjectRpc(group.instance),
          now
        );
      } catch (err) {
        getLogger().error(
          {
            instanceId: group.instance.id,
            mint: group.mint,
            error: err instanceof Error ? err.message : String(err),
          },
          "trackPendingWithdrawals: failed to reconcile release group"
        );
      }
    })
  );
}

interface ReleaseGroup {
  instance: PrivateChannelInstanceRow;
  mint: string;
  withdrawals: PrivateChannelWithdrawalRow[];
}

function releaseGroupKey(
  instance: PrivateChannelInstanceRow,
  withdrawal: PrivateChannelWithdrawalRow
): string {
  return `${instance.id}|${withdrawal.mint}`;
}

function logReconcileError(withdrawalId: string, status: string, err: unknown): void {
  getLogger().error(
    {
      withdrawalId,
      status,
      error: err instanceof Error ? err.message : String(err),
    },
    "trackPendingWithdrawals: failed to reconcile withdrawal"
  );
}

/** Fail a burn-signature-less withdrawal that has been stuck past the threshold. */
/**
 * The burn signature is persisted before the send, so a pending row carrying
 * one belongs to a request that died mid-send: the burn may have reached the
 * gateway. Promote it and let the submitted reconciliation ask, instead of
 * failing a burn that may have executed.
 */
async function promoteSignedPending(
  repo: PrivateChannelWithdrawalRepository,
  withdrawal: PrivateChannelWithdrawalRow,
  loadInstance: (id: string) => Promise<PrivateChannelInstanceRow | null>,
  reconcileSubmitted: (
    withdrawal: PrivateChannelWithdrawalRow,
    instance: PrivateChannelInstanceRow
  ) => Promise<void>,
  now: number
): Promise<void> {
  if (now - Date.parse(withdrawal.updated_at) <= STUCK_AFTER_MS) {
    return;
  }
  const promoted = await repo.updateWithdrawal({
    id: withdrawal.id,
    status: "submitted",
    expectedStatus: "pending",
  });
  if (!promoted) {
    return;
  }
  const instance = await loadInstance(promoted.instance_id);
  if (instance) {
    await reconcileSubmitted(promoted, instance);
  }
}

async function failIfStale(
  env: Env,
  repo: PrivateChannelWithdrawalRepository,
  withdrawal: PrivateChannelWithdrawalRow,
  now: number,
  reason: string
): Promise<void> {
  if (withdrawal.signature) {
    return;
  }
  await failStale(env, repo, withdrawal, now, reason, { expectedSignatureAbsent: true });
}

/** Signature-agnostic stale fail. Only legitimate pre-burn-confirmation. */
async function failStale(
  env: Env,
  repo: PrivateChannelWithdrawalRepository,
  withdrawal: PrivateChannelWithdrawalRow,
  now: number,
  reason: string,
  guard: { expectedSignatureAbsent?: boolean } = {}
): Promise<void> {
  if (now - Date.parse(withdrawal.updated_at) <= STUCK_AFTER_MS) {
    return;
  }
  const failed = await repo.updateWithdrawal({
    id: withdrawal.id,
    status: "failed",
    failureReason: reason,
    expectedStatus: withdrawal.status,
    expectedSignatureAbsent: guard.expectedSignatureAbsent ?? false,
  });
  if (failed) {
    await emitWithdrawalEvent(
      env,
      failed,
      PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_WITHDRAWAL_FAILED,
      "failed",
      { failureReason: reason }
    );
  }
}

/** submitted → confirmed/failed by applying an already-fetched burn status. */
async function applySubmittedVerdict(
  env: Env,
  repo: PrivateChannelWithdrawalRepository,
  withdrawal: PrivateChannelWithdrawalRow,
  status: solanaRpc.SignatureStatusInfo | null,
  now: number
): Promise<void> {
  if (!status) {
    if (now - Date.parse(withdrawal.updated_at) > STUCK_AFTER_MS) {
      const reason = "Withdrawal burn not found on chain.";
      const failed = await repo.updateWithdrawal({
        id: withdrawal.id,
        status: "failed",
        failureReason: reason,
        expectedStatus: "submitted",
      });
      if (failed) {
        await emitWithdrawalEvent(
          env,
          failed,
          PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_WITHDRAWAL_FAILED,
          "failed",
          { failureReason: reason }
        );
      }
    }
    return;
  }

  if (status.err) {
    // Verbatim by policy (tx-error.ts: operators need the real variant), but a
    // bare JSON.stringify throws on bigint-carrying errors.
    const reason = describeTransactionErr(status.err, "transaction failed");
    const failed = await repo.updateWithdrawal({
      id: withdrawal.id,
      status: "failed",
      failureReason: reason,
      expectedStatus: "submitted",
    });
    if (failed) {
      await emitWithdrawalEvent(
        env,
        failed,
        PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_WITHDRAWAL_FAILED,
        "failed",
        { failureReason: reason }
      );
    }
    return;
  }

  if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
    const confirmed = await repo.updateWithdrawal({
      id: withdrawal.id,
      status: "confirmed",
      expectedStatus: "submitted",
    });
    if (confirmed) {
      await emitWithdrawalEvent(
        env,
        confirmed,
        PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_WITHDRAWAL_CONFIRMED,
        "confirmed",
        { signature: withdrawal.signature }
      );
    }
  }
}

/**
 * confirmed → settled for one (instance, mint). Walks the instance escrow ATA's
 * devnet history backwards (SOLA9-157): pages with `before` until the parsed
 * frontier, the created_at lower bound, or history's end, parses release
 * candidates within a per-tick budget, and matches them against the batch's
 * (destinationAta, mint, amount). Claims the attribution via
 * `settlement_observations`, advances the intent, then — only when the walk
 * listed the region down to a provable stopping point and every non-terminal
 * withdrawal of this (instance, mint) was in the batch — moves the parsed
 * frontier up over the fully parsed prefix. Stale unmatched → stuck-warning
 * event, debounced via context.lastStuckWarningAt. NEVER auto-`failed` — the
 * burn is already confirmed.
 */
async function reconcileReleaseGroup(
  env: Env,
  repo: PrivateChannelWithdrawalRepository,
  observationRepo: PrivateChannelSettlementObservationRepository,
  releaseScanRepo: PrivateChannelReleaseScanRepository,
  group: ReleaseGroup,
  projectRpc: PrivateChannelProjectRpcClient,
  now: number
): Promise<void> {
  const withdrawals = group.withdrawals;
  if (withdrawals.length === 0) {
    return;
  }

  const cluster = projectRpc.cluster;
  const mint = address(group.mint);

  // Content matching needs this mint's own scale AND its owning token program: the
  // program seeds every ATA below, so guessing it would scan an address that never
  // receives the release. Every mint SDP writes comes from the instance allowlist,
  // so the catalogue resolves it; a row predating that (or a mint an operator
  // allowlisted out of band) falls back to what all such rows are — classic SPL at
  // six decimals.
  const knownMint = knownMintToken(group.mint, cluster);
  const decimals = knownMint?.decimals ?? 6;
  const tokenProgram = address(knownMint?.tokenProgram ?? TOKEN_PROGRAM_ADDRESS);

  // The release transfers FROM the instance escrow's ATA for this mint on devnet.
  const [vaultAta] = await findAssociatedTokenPda({
    owner: address(group.instance.escrow_instance_addr),
    mint,
    tokenProgram,
  });

  // Positions recorded for a different escrow ATA (the instance's escrow can
  // be rotated) are never read: history on this ATA has not been walked yet.
  const scan = await releaseScanRepo.getScan(group.instance.id, group.mint, vaultAta);
  const cursor = scan?.cursor ?? null;
  const rawSweep = scan?.sweep ?? null;
  let sweep = rawSweep;
  // A sweep at or behind the parsed frontier is a leftover (e.g. a clear that
  // lost a race): the listing it describes is already consumed.
  if (sweep && cursor && BigInt(sweep.slot) <= BigInt(cursor.slot)) {
    sweep = null;
  }

  // A release always postdates its withdrawal's intent creation, so a
  // cursor-less first scan never needs history older than the oldest
  // unsettled withdrawal's created_at (plus a skew margin). `created_at`
  // rather than `updated_at`: context patches (stuck warnings) move
  // `updated_at` forward and would shallow the bound past a real release.
  const lowerBoundMs =
    Math.min(...withdrawals.map((w) => Date.parse(w.created_at))) - RELEASE_SCAN_TIME_MARGIN_MS;

  const walk = await walkReleaseHistory(projectRpc.rpc, vaultAta, cursor, sweep, lowerBoundMs);
  if (!walk.complete) {
    getLogger().warn(
      {
        instanceId: group.instance.id,
        mint: group.mint,
        pages: sweep ? RELEASE_SCAN_MAX_PAGES - RELEASE_SCAN_TIP_PAGES : RELEASE_SCAN_MAX_PAGES,
      },
      "trackPendingWithdrawals: escrow history walk hit the page cap before a stopping point; cursor held, region stays due"
    );
  }

  // Oldest first. With a complete walk this points parsing at the region just
  // above the parsed frontier (or the created_at bound), so the parsed prefix
  // stays contiguous and the frontier can advance. With a capped walk the
  // frontier cannot move anyway; the newest candidates are the likeliest fresh
  // releases, so parse in walk order instead. Failed on-chain transactions
  // cannot contain a release and cost no lookup.
  const ordered = [...walk.entries].reverse();
  const parseTargets = (walk.complete ? ordered : walk.entries)
    .filter((s) => s.err === null)
    .slice(0, RELEASE_PARSE_BUDGET);

  const { releases, parsedSignatures } = await collectReleases(projectRpc.rpc, parseTargets);

  await settleWithdrawals(
    env,
    repo,
    observationRepo,
    mint,
    tokenProgram,
    decimals,
    releases,
    withdrawals,
    now
  );

  await persistScanPositions(
    repo,
    releaseScanRepo,
    group,
    vaultAta,
    cursor,
    rawSweep,
    walk,
    ordered,
    parsedSignatures
  );
}

/**
 * Claim the batch's content-matching releases and advance the withdrawals to
 * `settled`. Releases already claimed this tick, or found to be claimed by a
 * prior tick via PK conflict, are skipped on subsequent lookups. Withdrawals
 * with no matching release get a stuck-warning, debounced via
 * context.lastStuckWarningAt.
 */
async function settleWithdrawals(
  env: Env,
  repo: PrivateChannelWithdrawalRepository,
  observationRepo: PrivateChannelSettlementObservationRepository,
  mintAddress: Address,
  tokenProgram: Address,
  decimals: number,
  releases: ReleaseTransfer[],
  withdrawals: PrivateChannelWithdrawalRow[],
  now: number
): Promise<void> {
  const claimedSignatures = new Set<string>();
  // Oldest first so concurrent same-content withdrawals settle FIFO.
  const orderedWithdrawals = [...withdrawals].sort((a, b) =>
    a.created_at.localeCompare(b.created_at)
  );
  for (const withdrawal of orderedWithdrawals) {
    const [destinationAta] = await findAssociatedTokenPda({
      owner: address(withdrawal.destination),
      mint: mintAddress,
      tokenProgram,
    });
    const wantBaseUnits = parseDecimalAmount(withdrawal.amount, decimals);

    // All content-matching releases; walk them so a PK conflict on the first
    // pick doesn't orphan a same-content sibling withdrawal.
    const candidates = releases.filter(
      (r) => r.destination === destinationAta && r.baseUnits === wantBaseUnits
    );

    let settled = false;
    for (const match of candidates) {
      const key = `${match.signature}|${match.instructionIndex}`;
      if (claimedSignatures.has(key)) continue;

      const claim = await observationRepo.claimSettlement({
        signature: match.signature,
        instructionIndex: match.instructionIndex,
        intentKind: "withdrawal",
        intentId: withdrawal.id,
        destination: withdrawal.destination,
        mint: withdrawal.mint,
        amount: withdrawal.amount,
        blockTime: match.blockTime,
      });

      if (claim) {
        claimedSignatures.add(key);
        await advanceToSettled(env, repo, withdrawal, match.signature);
        settled = true;
        break;
      }

      // Claim failed. If findByIntent returns a row, this intent was already
      // settled elsewhere — advance from that signature. Otherwise the release
      // belongs to a different intent; mark it and try the next candidate.
      const winner = await observationRepo.findByIntent("withdrawal", withdrawal.id);
      if (winner) {
        await advanceToSettled(env, repo, withdrawal, winner.signature);
        settled = true;
        break;
      }
      claimedSignatures.add(key);
    }

    if (!settled) {
      await maybeEmitStuckWarning(env, repo, withdrawal, now);
    }
  }
}

/**
 * Persist the walk's listing progress and, when it is safe, the parsed
 * frontier.
 *
 * The sweep is written first: it only records how deep the walk listed, which
 * is matching-independent, and the repository only accepts deeper positions,
 * so a shallow proposal (or a concurrent tick's) is a no-op.
 *
 * The frontier advances only after the claims committed (a crash costs a
 * re-parse, never a lost release), only over the contiguous fully-parsed
 * prefix of the walked region, only on a walk that listed the region down to
 * a provable stopping point contiguous with the frontier, and only when this
 * group's unsettled set was provably complete.
 *
 * Group-complete, not batch-complete: a parsed release may only be skipped
 * for good when every withdrawal that could ever claim it was offered the
 * match. That means (a) no pending/submitted withdrawal remains for this
 * (instance, mint) — its release can already be on chain, and advancing past
 * it would strand the withdrawal forever once it confirms — and (b) the batch
 * was not truncated past this group's rows, and (c) unrelated groups filling
 * the global batch cannot hold this group's progress hostage. The count is
 * read per group and any failure holds the cursor.
 *
 * `startingCursor` is the cursor this tick read before walking. The frontier
 * proposal is always listed after it (the walk stops at that cursor), so the
 * repository accepts a same-slot advance — slots are not unique, and a
 * frontier that lands inside the cursor's slot must still move, or releases
 * above it in that slot could never be consumed — while a lagging poller's
 * same-slot proposal, anchored at a position it read earlier, fails the
 * compare-and-set and never regresses the frontier.
 */
async function persistScanPositions(
  repo: PrivateChannelWithdrawalRepository,
  releaseScanRepo: PrivateChannelReleaseScanRepository,
  group: ReleaseGroup,
  vaultAta: Address,
  startingCursor: PrivateChannelReleaseScanCursor | null,
  rawSweep: PrivateChannelReleaseScanCursor | null,
  walk: {
    complete: boolean;
    deepestListed: PrivateChannelReleaseScanCursor | null;
    sweepResumed: boolean;
    resumedBandLength: number;
  },
  ordered: solanaRpc.SignatureInfo[],
  parsedSignatures: Set<string>
): Promise<void> {
  if (walk.deepestListed) {
    await releaseScanRepo.deepenSweep({
      instanceId: group.instance.id,
      mint: group.mint,
      vaultAta,
      sweep: walk.deepestListed,
    });
  }

  let groupComplete: boolean;
  try {
    const nonTerminal = await repo.countNonTerminalByInstanceAndMint(group.instance.id, group.mint);
    groupComplete = nonTerminal === group.withdrawals.length;
  } catch (err) {
    getLogger().error(
      {
        instanceId: group.instance.id,
        mint: group.mint,
        error: err instanceof Error ? err.message : String(err),
      },
      "trackPendingWithdrawals: group completeness check failed; cursor held"
    );
    groupComplete = false;
  }
  if (!walk.complete || !groupComplete) {
    return;
  }

  // Walk the fully-parsed prefix, oldest first. When the walk resumed below a
  // sweep position, the prefix may only extend over the resumed band: it is
  // the sole region listed contiguously down from the sweep position to the
  // cursor. The tip band sits above an unlisted gap (between its floor and
  // the sweep position) — advancing past the band would mark releases in that
  // gap as parsed without ever examining them. Once the band is fully parsed
  // the sweep is cleared instead: the next walk starts with no sweep, lists
  // the whole region from the tip contiguously, and the frontier resumes
  // marching through the former gap.
  let frontier: PrivateChannelReleaseScanCursor | null = null;
  let resumedBandFullyParsed = walk.sweepResumed && walk.resumedBandLength === 0;
  const frontierLimit = walk.sweepResumed ? walk.resumedBandLength : ordered.length;
  for (let index = 0; index < frontierLimit; index += 1) {
    const entry = ordered[index];
    const complete = entry.err !== null || parsedSignatures.has(entry.signature);
    if (!complete) {
      break;
    }
    frontier = {
      signature: entry.signature,
      slot: entry.slot.toString(),
    };
    resumedBandFullyParsed = walk.sweepResumed && index === walk.resumedBandLength - 1;
  }
  if (frontier) {
    await releaseScanRepo.advanceScan({
      instanceId: group.instance.id,
      mint: group.mint,
      vaultAta,
      cursor: frontier,
      expectedCursorSignature: startingCursor?.signature ?? null,
    });
    // The frontier consumed the listed backlog — the sweep has nothing left
    // to resume and the next walk can target the frontier directly.
    if (walk.sweepResumed && resumedBandFullyParsed) {
      await releaseScanRepo.clearSweep({
        instanceId: group.instance.id,
        mint: group.mint,
        vaultAta,
      });
    } else if (!walk.sweepResumed && rawSweep && BigInt(frontier.slot) >= BigInt(rawSweep.slot)) {
      await releaseScanRepo.clearSweep({
        instanceId: group.instance.id,
        mint: group.mint,
        vaultAta,
      });
    }
  } else if (walk.sweepResumed && resumedBandFullyParsed) {
    // A resumed band that listed nothing is already behind the cursor.
    await releaseScanRepo.clearSweep({
      instanceId: group.instance.id,
      mint: group.mint,
      vaultAta,
    });
  }
}

/**
 * Newest-first backward walk over the escrow ATA's address history, stopping at
 * the first provable bound: the persisted cursor (everything at or behind it
 * was parsed on an earlier tick), the created_at lower bound (only checked
 * cursor-less — with a cursor the walk's job is exactly the unparsed region
 * above it, whatever its age), history's end, or the page cap.
 *
 * Two phases, so a backlog deeper than one tick's page cap still gets walked
 * instead of being re-read from the tip forever:
 *
 * 1. Tip band — the newest entries, where fresh releases land. With a sweep
 *    pending this is a small fixed budget; every entry passes through it on
 *    arrival, and the deep region is the sweep's job.
 * 2. Sweep — when a previous capped walk persisted where it stopped, resume
 *    listing below that signature toward the cursor with the remaining page
 *    budget. Each tick marches the sweep deeper, so the backlog is eventually
 *    listed down to the cursor and the parsed frontier can consume it.
 *
 * `complete` reports whether the listed region reaches a provable stopping
 * point contiguous with the frontier (or, cursor-less, the created_at bound or
 * history's end) — the precondition for advancing the frontier. `deepestListed`
 * carries where a capped walk stopped so it can be persisted as the sweep.
 */
async function walkReleaseHistory(
  rpc: solanaRpc.SolanaRpc,
  vaultAta: Address,
  cursor: PrivateChannelReleaseScanCursor | null,
  sweep: PrivateChannelReleaseScanCursor | null,
  lowerBoundMs: number
): Promise<{
  entries: solanaRpc.SignatureInfo[];
  complete: boolean;
  deepestListed: PrivateChannelReleaseScanCursor | null;
  /** Phase 2 ran below a persisted sweep position. */
  sweepResumed: boolean;
  /** How many of `entries` belong to the resumed deep band (contiguous with the cursor). */
  resumedBandLength: number;
}> {
  const entries: solanaRpc.SignatureInfo[] = [];

  const listBackward = async (
    startBefore: Signature | undefined,
    maxPages: number
  ): Promise<{
    stoppedAt: "cursor" | "bound" | "end" | "cap";
    deepest: PrivateChannelReleaseScanCursor | null;
  }> => {
    let before = startBefore;
    let deepest: PrivateChannelReleaseScanCursor | null = null;
    for (let page = 0; page < maxPages; page += 1) {
      const infos = await solanaRpc.getSignaturesForAddress(rpc, vaultAta, {
        limit: RELEASE_SCAN_PAGE_LIMIT,
        ...(before ? { before } : {}),
      });
      if (infos.length === 0) {
        return { stoppedAt: "end", deepest };
      }
      for (const info of infos) {
        // Slots are not unique — several transactions can share one, and the
        // listing's order within a slot is only consistent with itself. Only
        // entries at a STRICTLY older slot are provably inside the parsed
        // prefix; same-slot entries are always listed and matched by
        // signature, so an unparsed same-slot sibling of the frontier is
        // never skipped.
        if (
          cursor &&
          (info.signature === cursor.signature ||
            (info.slot !== null && BigInt(info.slot) < BigInt(cursor.slot)))
        ) {
          return { stoppedAt: "cursor", deepest };
        }
        if (!cursor && info.blockTime !== null && Number(info.blockTime) * 1000 < lowerBoundMs) {
          return { stoppedAt: "bound", deepest };
        }
        entries.push(info);
        deepest = { signature: info.signature, slot: info.slot.toString() };
      }
      if (infos.length < RELEASE_SCAN_PAGE_LIMIT) {
        return { stoppedAt: "end", deepest };
      }
      before = infos[infos.length - 1].signature;
    }
    return { stoppedAt: "cap", deepest };
  };

  // Phase 1 — tip band.
  const tip = await listBackward(
    undefined,
    sweep ? RELEASE_SCAN_TIP_PAGES : RELEASE_SCAN_MAX_PAGES
  );
  if (tip.stoppedAt !== "cap") {
    return {
      entries,
      complete: true,
      deepestListed: null,
      sweepResumed: false,
      resumedBandLength: 0,
    };
  }
  if (!sweep) {
    // First capped walk: the tip band's deepest point is where a later tick
    // resumes listing.
    return {
      entries,
      complete: false,
      deepestListed: tip.deepest,
      sweepResumed: false,
      resumedBandLength: 0,
    };
  }
  // Phase 2 — resume below the persisted sweep position toward the cursor.
  // The band it lists is contiguous with the cursor; the region between the
  // tip band's floor and the sweep position is NOT relisted this tick, so the
  // frontier may only advance over the band (see persistScanPositions).
  const bandStart = entries.length;
  const remaining = RELEASE_SCAN_MAX_PAGES - RELEASE_SCAN_TIP_PAGES;
  const resumed = await listBackward(sweep.signature, remaining);
  return {
    entries,
    complete: resumed.stoppedAt !== "cap",
    deepestListed: resumed.stoppedAt === "cap" ? resumed.deepest : null,
    sweepResumed: true,
    resumedBandLength: entries.length - bandStart,
  };
}

async function advanceToSettled(
  env: Env,
  repo: PrivateChannelWithdrawalRepository,
  withdrawal: PrivateChannelWithdrawalRow,
  settlementRef: string
): Promise<void> {
  const settled = await repo.updateWithdrawal({
    id: withdrawal.id,
    status: "settled",
    settlementRef,
    expectedStatus: "confirmed",
  });
  if (settled) {
    await emitWithdrawalEvent(
      env,
      settled,
      PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_WITHDRAWAL_SETTLED,
      "confirmed",
      { signature: settlementRef }
    );
  }
}

/**
 * Emit a stuck-warning if we haven't seen the operator's release within the
 * threshold. Debounced via `context.lastStuckWarningAt` on the withdrawal so
 * we alert once per hour rather than on every tick.
 */
async function maybeEmitStuckWarning(
  env: Env,
  repo: PrivateChannelWithdrawalRepository,
  withdrawal: PrivateChannelWithdrawalRow,
  now: number
): Promise<void> {
  if (now - Date.parse(withdrawal.updated_at) <= RELEASE_STUCK_AFTER_MS) {
    return;
  }
  const lastRaw = withdrawal.context.lastStuckWarningAt;
  const lastMs = typeof lastRaw === "string" ? Date.parse(lastRaw) : NaN;
  if (Number.isFinite(lastMs) && now - lastMs < STUCK_WARNING_INTERVAL_MS) {
    return;
  }
  const nowIso = new Date(now).toISOString();
  await repo.patchContext(withdrawal.id, { lastStuckWarningAt: nowIso });
  await emitWithdrawalEvent(
    env,
    withdrawal,
    PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_STUCK_WARNING,
    "stale",
    {
      reason: "Devnet release not observed within the timeout.",
      confirmedAt: withdrawal.updated_at,
    }
  );
}

interface ReleaseTransfer {
  signature: Signature;
  /** Destination TOKEN ACCOUNT (ATA), as reported by the parsed transfer. */
  destination: string;
  baseUnits: bigint;
  instructionIndex: number;
  blockTime: number | null;
}

/**
 * Fetch + parse each signature, extracting outgoing SPL token transfers.
 *
 * Returns the releases (in the caller's order, so a deepest-first target list
 * yields oldest-first candidates) plus the set of signatures whose transaction
 * was actually resolved: a signature the RPC could not serve stays unparsed,
 * which holds the scan cursor above it until a later tick serves it.
 */
async function collectReleases(
  rpc: solanaRpc.SolanaRpc,
  signatures: { signature: Signature; blockTime: bigint | null }[]
): Promise<{ releases: ReleaseTransfer[]; parsedSignatures: Set<string> }> {
  // Bounded: the parse budget caps how many signatures enter this list, and a
  // bare Promise.all would still open that many concurrent getTransaction calls
  // against the RPC in one tick — and a serial loop would pay the latency of
  // one round trip per signature. A failed lookup drops that candidate release
  // (logged below) and holds the cursor above it; the next tick retries.
  const settled = await mapSettledWithConcurrency(
    signatures,
    RELEASE_LOOKUP_CONCURRENCY,
    async ({ signature, blockTime }) => {
      const tx = await solanaRpc.getTransaction(rpc, signature);
      if (!tx) {
        return { transfers: [] as ReleaseTransfer[], found: false };
      }
      if (tx.err) {
        // A failed transaction cannot contain a release, but the lookup did
        // resolve what the chain recorded.
        return { transfers: [] as ReleaseTransfer[], found: true };
      }
      const transfers: ReleaseTransfer[] = [];
      // Same-tx multiple transfers keep their index so batched releases don't
      // collide on the settlement_observations PK.
      tx.instructions.forEach((ix, index) => {
        const parsed = parseTokenTransfer(ix);
        if (parsed) {
          transfers.push({
            signature,
            destination: parsed.destination,
            baseUnits: parsed.baseUnits,
            instructionIndex: index,
            blockTime: blockTime === null ? null : Number(blockTime),
          });
        }
      });
      return { transfers, found: true };
    }
  );
  const parsedSignatures = new Set<string>();
  settled.forEach((result, index) => {
    if (result.status === "fulfilled" && result.value.found) {
      parsedSignatures.add(signatures[index]?.signature as string);
    }
  });
  const releases = settled.flatMap((result, index) => {
    if (result.status === "fulfilled") {
      return result.value.transfers;
    }
    // The lookup failure must not vanish silently: operators need to know the
    // scan was incomplete, otherwise unresolved withdrawals and missing
    // releases surface with no diagnostic explaining why.
    getLogger().error(
      {
        signature: signatures[index]?.signature,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      },
      "trackPendingWithdrawals: release getTransaction lookup failed; dropping candidate until next tick"
    );
    return [];
  });
  return { releases, parsedSignatures };
}

/** Pull (destinationTokenAccount, baseUnits) from a parsed spl-token transfer ix. */
function parseTokenTransfer(
  ix: solanaRpc.ParsedInstruction
): { destination: string; baseUnits: bigint } | null {
  if (ix.parsedType !== "transfer" && ix.parsedType !== "transferChecked") {
    return null;
  }
  const info = ix.info;
  if (!info) {
    return null;
  }
  const destination = typeof info.destination === "string" ? info.destination : null;
  if (!destination) {
    return null;
  }
  // `transfer` reports a bare `amount`; `transferChecked` nests it under `tokenAmount`.
  const rawAmount =
    typeof info.amount === "string"
      ? info.amount
      : ((info.tokenAmount as { amount?: string } | undefined)?.amount ?? null);
  if (rawAmount === null) {
    return null;
  }
  let baseUnits: bigint;
  try {
    baseUnits = BigInt(rawAmount);
  } catch {
    return null;
  }
  return { destination, baseUnits };
}
