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
 *     (pre-burn-confirmation — no balance moved yet).
 *  3. `confirmed` → `settled` via the polling oracle: scan the CURRENT
 *     instance's escrow ATA on devnet for outgoing SPL transfers matching a
 *     withdrawal's (destinationAta, mint, baseUnits), CLAIM the match by
 *     inserting into `private_channel_settlement_observations` (UNIQUE guards
 *     against double-claim + racing pollers), then CAS-advance the withdrawal
 *     to `settled` with `settlement_ref = signature`. Stale unmatched → operator
 *     `TRANSFER_STUCK_WARNING` (debounced via `context.lastStuckWarningAt`),
 *     never auto-`failed` — the balance is already burned.
 *
 * The reconciler always reads the CURRENT instance row for RPC endpoints, so an
 * operator repointing a stale endpoint doesn't strand in-flight intents. The
 * audit context on each withdrawal is never consulted here.
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
import { address, type Signature } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  createPrivateChannelInstanceRepository,
  createPrivateChannelSettlementObservationRepository,
  createPrivateChannelWithdrawalRepository,
  type PrivateChannelInstanceRow,
  type PrivateChannelSettlementObservationRepository,
  type PrivateChannelWithdrawalRepository,
  type PrivateChannelWithdrawalRow,
} from "@/db/repositories";
import { getLogger } from "@/runtime/logger";
import { inferCluster, knownMintToken } from "@/services/private-channels/mint";
import { emitWithdrawalEvent } from "@/services/private-channels/withdraw-events";
import type { Env } from "@/types/env";

const STUCK_AFTER_MS = 5 * 60 * 1000;
/** How long to wait for the operator's devnet release before pinging the operator. */
const RELEASE_STUCK_AFTER_MS = 30 * 60 * 1000;
/** Rate-limit the stuck-warning event: at most once per hour per withdrawal. */
const STUCK_WARNING_INTERVAL_MS = 60 * 60 * 1000;
const MAX_PER_RUN = 100;
/** How many recent instance-ATA signatures to scan for releases per group. */
const RELEASE_SCAN_LIMIT = 100;

export async function trackPendingWithdrawals(env: Env): Promise<void> {
  const repo = createPrivateChannelWithdrawalRepository(env);
  const instanceRepo = createPrivateChannelInstanceRepository(env);
  const observationRepo = createPrivateChannelSettlementObservationRepository(env);
  const pending = await repo.listNonTerminal(MAX_PER_RUN);
  if (pending.length === 0) {
    return;
  }

  const instances = new Map<string, PrivateChannelInstanceRow | null>();
  const loadInstance = async (id: string) => {
    if (instances.has(id)) {
      return instances.get(id) ?? null;
    }
    const row = await instanceRepo.getById(id);
    instances.set(id, row);
    return row;
  };

  const now = Date.now();

  // Phase 1 — pending/submitted per withdrawal.
  for (const withdrawal of pending) {
    try {
      if (withdrawal.status === "pending") {
        await failIfStale(env, repo, withdrawal, now, "Withdrawal burn was never broadcast.");
      } else if (withdrawal.status === "submitted") {
        const instance = await loadInstance(withdrawal.instance_id);
        if (!instance) {
          // No instance to reconcile against; pre-burn-confirmation, so `failed`
          // is legitimate. Only auto-fail past the stale window.
          await failStale(env, repo, withdrawal, now, "Withdrawal instance no longer connected.");
          continue;
        }
        await reconcileSubmitted(env, repo, withdrawal, instance, now);
      }
      // `confirmed` handled by the release-observation pass below.
    } catch (err) {
      logReconcileError(withdrawal.id, withdrawal.status, err);
    }
  }

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

  for (const group of groups.values()) {
    try {
      await reconcileReleaseGroup(env, repo, observationRepo, group, now);
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
  }
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
  await failStale(env, repo, withdrawal, now, reason);
}

/** Signature-agnostic stale fail. Only legitimate pre-burn-confirmation. */
async function failStale(
  env: Env,
  repo: PrivateChannelWithdrawalRepository,
  withdrawal: PrivateChannelWithdrawalRow,
  now: number,
  reason: string
): Promise<void> {
  if (now - Date.parse(withdrawal.updated_at) <= STUCK_AFTER_MS) {
    return;
  }
  const failed = await repo.updateWithdrawal({
    id: withdrawal.id,
    status: "failed",
    failureReason: reason,
    expectedStatus: withdrawal.status,
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

/** submitted → confirmed/failed via the burn's gateway signature status. */
async function reconcileSubmitted(
  env: Env,
  repo: PrivateChannelWithdrawalRepository,
  withdrawal: PrivateChannelWithdrawalRow,
  instance: PrivateChannelInstanceRow,
  now: number
): Promise<void> {
  if (!withdrawal.signature) {
    await failIfStale(env, repo, withdrawal, now, "Withdrawal was submitted without a signature.");
    return;
  }

  // Burn is on the gateway (channel chain). No auth here — auth-enabled instances
  // will need to be wired through this call the way withdraw-confirm.ts does.
  // TODO(auth): plumb resolveMemberGatewayAuth into the cron path once we need it.
  const rpc = solanaRpc.createRpc(env, { rpcUrl: instance.gateway_url });
  const [status] = await solanaRpc.getSignatureStatuses(rpc, [withdrawal.signature as Signature]);

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
    const reason = JSON.stringify(status.err);
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
 * confirmed → settled for one (instance, mint). Scans the instance escrow ATA's
 * recent devnet signatures for outgoing transfers matching a pending withdrawal's
 * (destinationAta, mint, amount), claims the attribution via
 * `settlement_observations`, and advances the intent. Stale unmatched →
 * stuck-warning event, debounced via context.lastStuckWarningAt. NEVER
 * auto-`failed` — the burn is already confirmed.
 */
async function reconcileReleaseGroup(
  env: Env,
  repo: PrivateChannelWithdrawalRepository,
  observationRepo: PrivateChannelSettlementObservationRepository,
  group: ReleaseGroup,
  now: number
): Promise<void> {
  const withdrawals = group.withdrawals;
  if (withdrawals.length === 0) {
    return;
  }

  const cluster = inferCluster(group.instance.chain_rpc_url);
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

  const rpc = solanaRpc.createRpc(env, { rpcUrl: group.instance.chain_rpc_url });
  const sigInfos = await solanaRpc.getSignaturesForAddress(rpc, vaultAta, {
    limit: RELEASE_SCAN_LIMIT,
  });

  // Collect the outgoing token transfers seen on the vault ATA. Same-tx multiple
  // transfers keep their index so batched releases don't collide on the
  // settlement_observations PK.
  const releases = await collectReleases(
    rpc,
    sigInfos.filter((s) => !s.err).map((s) => ({ signature: s.signature, blockTime: s.blockTime }))
  );

  // Releases already claimed this tick, or found to be claimed by a prior tick
  // via PK conflict. Skip them on subsequent lookups.
  const claimedSignatures = new Set<string>();
  // Oldest first so concurrent same-content withdrawals settle FIFO.
  const ordered = [...withdrawals].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const withdrawal of ordered) {
    const [destinationAta] = await findAssociatedTokenPda({
      owner: address(withdrawal.destination),
      mint,
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

/** Fetch + parse each signature, extracting outgoing SPL token transfers. */
async function collectReleases(
  rpc: solanaRpc.SolanaRpc,
  signatures: { signature: Signature; blockTime: bigint | null }[]
): Promise<ReleaseTransfer[]> {
  const releases: ReleaseTransfer[] = [];
  for (const { signature, blockTime } of signatures) {
    const tx = await solanaRpc.getTransaction(rpc, signature);
    if (!tx || tx.err) {
      continue;
    }
    tx.instructions.forEach((ix, index) => {
      const parsed = parseTokenTransfer(ix);
      if (parsed) {
        releases.push({
          signature,
          destination: parsed.destination,
          baseUnits: parsed.baseUnits,
          instructionIndex: index,
          blockTime: blockTime === null ? null : Number(blockTime),
        });
      }
    });
  }
  return releases;
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
