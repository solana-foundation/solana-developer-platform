/**
 * Earn deposit-observation sweep (PRO-1669).
 *
 * INTERIM MECHANISM, ON PURPOSE. This cron exists because provider-API polling is
 * the only deposit observer SDP has today. The durable record it writes is
 * source-agnostic (`services/earn-deposit-ledger.service.ts`): provider webhooks
 * (PRO-1631) will write the same row through the same applier, and eventually an
 * SDP indexer reading Solana directly will too — that is the DESIRED end state,
 * and this module is expected to become a backstop and then to be deleted. Nothing
 * downstream may assume the poller is the writer.
 *
 * Two execution paths, both gated on the Earn flags by their callers, exactly like
 * the catalogue sync:
 * - **In-process cron** (`runEarnDepositSweep`): self-hosted runtimes and
 *   explicitly opted-in services.
 * - **Managed Cloud Run Job** (`runEarnDepositSweepIfDue`, `src/job.ts`): the job
 *   ticks every five minutes, so each tick claims this task's own cadence slot
 *   first and skips quietly when it is held — the cadence stays
 *   EARN_DEPOSIT_SWEEP_CRON no matter how often the job runs. Registering only
 *   in-process would mean the sweep never runs in a deployed environment at all,
 *   because `isCronDisabled` turns in-process cron off whenever K_SERVICE is set.
 *
 * THE PASS WALKS EACH FEED FROM THE HEAD EVERY TIME, and that is deliberate rather
 * than lazy. The provider deposits feed has no `since` filter, no page-size
 * parameter, and an opaque cursor of undocumented order, so every cheap
 * termination rule is order-dependent and wrong in one direction: a watermark
 * ("stop when a page predates what we've seen") breaks on an ascending feed by
 * stopping on page one, and "stop on a fully-known page" breaks on an ascending
 * feed's first page — which is precisely the steady state. Terminating on
 * `nextCursor === null` is correct under ANY ordering and costs a handful of
 * requests per program at V1 volumes, because a re-observed terminal row is one
 * indexed SELECT and zero writes. MAX_PAGES_PER_WALLET bounds a pathological
 * history and persists the unfinished cursor so a long walk makes forward progress
 * instead of restarting. DO NOT add a stop-early rule until the provider documents
 * an order or ships a `since` filter — there is a test pinning the full walk.
 *
 * It degrades wallet-by-wallet and row-by-row: a de-registered provider, a provider
 * without the portfolio capability, and an environment with no credentials are all
 * steady states that skip quietly, and one failing program can never sink the
 * platform's pass. It gates nothing — it is not a request path and never decides
 * whether money may move.
 *
 * Adding a provider is a registry change only: neither execution path names one,
 * and capability comes from `supportsPortfolioWallets`.
 */

import { resolveEarnProviderClient, SdpEarnError, supportsPortfolioWallets } from "@sdp/earn";
import type { EarnPortfolioWalletProvider, EarnRuntimeContext } from "@sdp/earn/types";
import type { SdpEnvironment } from "@sdp/types";
import {
  createEarnRepository,
  type EarnProviderWalletRow,
  type EarnRepository,
} from "@/db/repositories";
import type { BackgroundRunner } from "@/runtime/background";
import type { KVStore } from "@/runtime/kv";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { getLogger } from "@/runtime/logger";
import type { Observability } from "@/runtime/observability";
import {
  applyEarnDepositObservation,
  depositObservationFromProviderRead,
} from "@/services/earn-deposit-ledger.service";
import type { Env } from "@/types/env";
import { claimCronSlot, releaseCronSlot, withCronDeadline } from "./slot";

export const EARN_DEPOSIT_SWEEP_MONITOR = "sdp-api-sweep-earn-deposits";

/**
 * Fifteen minutes, not hourly. The catalogue is hourly because catalogue drift is
 * slow; deposits are money arriving. User-visible freshness is already met by the
 * live deposits route (which the dashboard polls every 15 seconds and which writes
 * the ledger as a side effect), so this cadence is an AUDIT requirement — and "a
 * deposit missing from the audit trail for up to an hour" is a bad answer during an
 * incident. It is also a clean multiple of the job's five-minute grid.
 */
export const EARN_DEPOSIT_SWEEP_CRON = "*/15 * * * *";

/** Just under the cadence, so the next on-cadence tick finds a fresh slot. */
export const EARN_DEPOSIT_SWEEP_SLOT_TTL_SECONDS = 840;

/**
 * Lease validity: a claim only guarantees mutual exclusion while the holder's work
 * is bounded well below the claim's expiry. Note managed Cloud Run additionally
 * caps the whole job execution at 120s (sdp-infra), far under this — and this task
 * runs LAST in `src/job.ts` precisely so a slow sweep starves nothing after it.
 * Being cut off is progress-preserving, not progress-losing: the wallet-scan and
 * per-wallet cursors are persisted.
 */
export const EARN_DEPOSIT_SWEEP_DEADLINE_SECONDS = 300;

const EARN_DEPOSIT_SWEEP_SLOT_KEY = "cron:earn-deposit-sweep:slot";

/**
 * Bounded work per pass. The wallet cap makes the pass predictable; the wallet-scan
 * resume key below is what stops the cap from starving every program past it
 * FOREVER, which is why that key is not optional.
 */
const MAX_WALLETS_PER_RUN = 200;
const MAX_PAGES_PER_WALLET = 20;

/**
 * Resume pointers are bounded rather than permanent. A long walk advances every
 * cadence window, so a day is ample headroom — while a pointer for a wallet that
 * stops being swept at all (a deleted program, a provider migration) expires
 * instead of lingering forever. Expiry is safe: losing a pointer only restarts
 * that wallet's walk from the head, which is idempotent.
 */
const EARN_DEPOSIT_SWEEP_CURSOR_TTL_SECONDS = 86_400;

/** Credentials are per environment, so each is swept with its own runtime context. */
const SWEPT_ENVIRONMENTS: readonly SdpEnvironment[] = ["sandbox", "production"];

/**
 * Expected steady states, not incidents: a provider without the portfolio
 * capability reports NOT_IMPLEMENTED, and an environment without credentials
 * reports PROVIDER_NOT_CONFIGURED before any network call. A pre-launch production
 * environment is the second case, so neither may fail the tick.
 */
const SKIPPABLE_SWEEP_ERROR_CODES: ReadonlySet<string> = new Set([
  "NOT_IMPLEMENTED",
  "PROVIDER_NOT_CONFIGURED",
]);

export interface EarnDepositSweepResult {
  walletsScanned: number;
  walletsSkipped: number;
  pagesFetched: number;
  depositsObserved: number;
  failures: number;
}

function walletScanKey(environment: SdpEnvironment): string {
  return `cron:earn-deposit-sweep:wallet-scan:${environment}`;
}

function depositCursorKey(walletId: string): string {
  return `cron:earn-deposit-sweep:cursor:${walletId}`;
}

/** `<createdAt>|<id>` — the keyset position the next pass resumes from. */
function encodeScanCursor(row: EarnProviderWalletRow): string {
  return `${row.created_at}|${row.id}`;
}

function decodeScanCursor(value: string | null): { createdAt: string; id: string } | undefined {
  if (value === null) {
    return undefined;
  }
  const separator = value.lastIndexOf("|");
  if (separator === -1) {
    return undefined;
  }
  return { createdAt: value.slice(0, separator), id: value.slice(separator + 1) };
}

/**
 * Whether the provider rejected the CURSOR, as opposed to failing the request.
 *
 * `classifyProviderStatus` maps 409 to CONFLICT, 429 to RATE_LIMITED and 5xx to
 * PROVIDER_UNAVAILABLE, leaving BAD_REQUEST as "the provider read this request and
 * refused it" — the only class that is evidence about the cursor we sent. A raw
 * transport error is not an SdpEarnError at all and is transient by definition.
 */
function isRejectedCursor(error: unknown): boolean {
  return error instanceof SdpEarnError && error.code === "BAD_REQUEST";
}

function skippableCode(error: unknown): string | undefined {
  return error instanceof SdpEarnError && SKIPPABLE_SWEEP_ERROR_CODES.has(error.code)
    ? error.code
    : undefined;
}

export async function sweepEarnDeposits(env: Env): Promise<EarnDepositSweepResult> {
  const repo = createEarnRepository(env);
  const cache = createKVStoreSet(env).cache;
  // Providers read their own credentials from the raw env keyed by environment —
  // the same contract as the route layer's earnRuntime().
  const providerEnv = env as unknown as Record<string, string | undefined>;

  const result: EarnDepositSweepResult = {
    walletsScanned: 0,
    walletsSkipped: 0,
    pagesFetched: 0,
    depositsObserved: 0,
    failures: 0,
  };

  for (const environment of SWEPT_ENVIRONMENTS) {
    await sweepEnvironment(repo, cache, { env: providerEnv, environment }, result);
  }

  getLogger().info({ ...result }, "sweepEarnDeposits: pass complete");
  return result;
}

async function sweepEnvironment(
  repo: EarnRepository,
  cache: KVStore,
  ctx: EarnRuntimeContext,
  result: EarnDepositSweepResult
): Promise<void> {
  const environment = ctx.environment;
  const scanKey = walletScanKey(environment);
  const after = decodeScanCursor(await cache.get(scanKey));

  const wallets = await repo.scanProviderWallets({
    environment,
    ...(after !== undefined && { after }),
    limit: MAX_WALLETS_PER_RUN,
  });

  // Capability and credentials are a property of (provider, environment), not of
  // a wallet, so resolve the decision ONCE per provider per tick. Without this an
  // un-credentialed environment logs one skip per program — noise that drowns real
  // signal on the exact pass an operator would be reading.
  const clientsByProvider = new Map<string, EarnPortfolioWalletProvider | null>();

  for (const wallet of wallets) {
    const client = resolveSweepClient(clientsByProvider, wallet, environment);
    if (client === null) {
      result.walletsSkipped += 1;
      continue;
    }

    try {
      await sweepWallet(repo, cache, client, ctx, wallet, result);
      result.walletsScanned += 1;
    } catch (error) {
      const code = skippableCode(error);
      if (code !== undefined) {
        // Credentials can also fail on the first real call rather than at
        // resolution; treat it as the same steady state and memoize it so the
        // remaining wallets on this provider short-circuit.
        clientsByProvider.set(wallet.provider, null);
        result.walletsSkipped += 1;
        getLogger().info(
          { provider: wallet.provider, environment, code },
          "sweepEarnDeposits: provider skipped"
        );
        continue;
      }
      result.failures += 1;
      getLogger().error(
        {
          provider: wallet.provider,
          environment,
          walletId: wallet.id,
          error: error instanceof Error ? error.message : String(error),
        },
        "sweepEarnDeposits: wallet pass failed"
      );
    }
  }

  // The scan checkpoint advances only AFTER this batch has been processed, never
  // before it.
  //
  // Checkpointing on fetch looks equivalent and is not: the pass can end early at
  // any point — its own deadline, the managed job's 120s execution cap, or the
  // process simply being killed — and a checkpoint written up front would then
  // point PAST wallets nothing swept. Those programs would be skipped until the
  // environment scan wrapped all the way around, leaving their deposit history
  // stale for several cadence windows with nothing reporting it.
  //
  // Advancing here inverts the failure: an interrupted pass leaves the checkpoint
  // where it was, so the next one re-walks this batch. Re-walking is free of
  // consequence — every observation is idempotent, and a re-observed terminal row
  // costs one indexed SELECT and zero writes — so replay is strictly better than
  // a silent skip.
  if (wallets.length < MAX_WALLETS_PER_RUN) {
    // Reached the end of the collection: next pass starts over at the head.
    // Clearing here (rather than only on an empty page) is what keeps a platform
    // with fewer programs than the cap from carrying a stale cursor.
    await cache.delete(scanKey);
    return;
  }
  const last = wallets[wallets.length - 1];
  if (last) {
    await cache.put(scanKey, encodeScanCursor(last));
  }
}

/**
 * Resolve (and memoize) the client for a wallet's provider, or null when this
 * provider cannot be swept in this environment.
 *
 * Dispatch goes through the fail-closed registry because `provider` is an open TEXT
 * column that may name a de-registered provider, and capability comes from the
 * method-presence guard — never a provider-id check.
 */
function resolveSweepClient(
  cacheByProvider: Map<string, EarnPortfolioWalletProvider | null>,
  wallet: EarnProviderWalletRow,
  environment: SdpEnvironment
): EarnPortfolioWalletProvider | null {
  const memoized = cacheByProvider.get(wallet.provider);
  if (memoized !== undefined) {
    return memoized;
  }

  let resolved: EarnPortfolioWalletProvider | null = null;
  try {
    const client = resolveEarnProviderClient(wallet.provider);
    resolved = supportsPortfolioWallets(client) ? client : null;
    if (resolved === null) {
      getLogger().info(
        { provider: wallet.provider, environment },
        "sweepEarnDeposits: provider has no portfolio-wallet capability, skipping"
      );
    }
  } catch (error) {
    // A row naming a retired provider must not crash the pass.
    getLogger().info(
      {
        provider: wallet.provider,
        environment,
        error: error instanceof Error ? error.message : String(error),
      },
      "sweepEarnDeposits: provider not resolvable, skipping"
    );
  }

  cacheByProvider.set(wallet.provider, resolved);
  return resolved;
}

async function sweepWallet(
  repo: EarnRepository,
  cache: KVStore,
  client: EarnPortfolioWalletProvider,
  ctx: EarnRuntimeContext,
  wallet: EarnProviderWalletRow,
  result: EarnDepositSweepResult
): Promise<void> {
  const cursorKey = depositCursorKey(wallet.id);
  // Only set when a prior pass hit the page cap mid-walk.
  const persistedCursor = await cache.get(cursorKey);
  let cursor = persistedCursor ?? undefined;
  // Whether the cursor about to be sent came from a PREVIOUS pass. Only such a
  // cursor can be stale, and only a stale one is worth invalidating.
  let resuming = persistedCursor !== null;
  let pages = 0;

  while (pages < MAX_PAGES_PER_WALLET) {
    let page: Awaited<ReturnType<typeof client.listPortfolioDeposits>>;
    try {
      page = await client.listPortfolioDeposits(ctx, {
        providerWalletRef: wallet.provider_wallet_ref,
        ...(cursor !== undefined && { cursor }),
      });
    } catch (error) {
      // A resume pointer the provider will not accept — expired, or invalidated by
      // a provider-side format change — would otherwise wedge THIS wallet forever:
      // the cursor is only deleted on a complete walk, so every later pass would
      // replay the identical failing request while the sweep still reports a
      // healthy check-in. Drop it so the failure costs one pass, not all of them.
      //
      // Narrowed to a REJECTED cursor specifically. A network outage, a 429, or a
      // provider 5xx says nothing about the cursor's validity, and discarding it on
      // those would throw away real pagination progress — for a wallet with more
      // than MAX_PAGES_PER_WALLET pages of history that means the walk restarts at
      // the head every time and can never reach the end. Only a client-side
      // rejection (a 4xx that is not 409/429, which the provider fetch layer
      // classifies as BAD_REQUEST) is evidence about the cursor itself.
      if (resuming && isRejectedCursor(error)) {
        await cache.delete(cursorKey);
        getLogger().warn(
          { walletId: wallet.id, provider: wallet.provider },
          "sweepEarnDeposits: discarded a rejected resume cursor; next pass restarts from the head"
        );
      }
      throw error;
    }
    // Any cursor from here on was minted by THIS pass, so it cannot be stale.
    resuming = false;
    pages += 1;
    result.pagesFetched += 1;

    const observedAt = new Date().toISOString();
    for (const deposit of page.deposits) {
      try {
        await applyEarnDepositObservation({
          repo,
          wallet,
          observation: depositObservationFromProviderRead(deposit, "provider_poll", observedAt),
        });
        result.depositsObserved += 1;
      } catch (error) {
        // One bad row never sinks the wallet, let alone the pass.
        result.failures += 1;
        getLogger().error(
          {
            walletId: wallet.id,
            providerReference: deposit.id,
            error: error instanceof Error ? error.message : String(error),
          },
          "sweepEarnDeposits: deposit observation failed"
        );
      }
    }

    if (page.nextCursor === null) {
      // A complete walk: start from the head again next pass.
      await cache.delete(cursorKey);
      return;
    }
    cursor = page.nextCursor;

    // Persist after EVERY completed page, not once at the end of the loop.
    // Otherwise a deterministic failure on page 2 is unrecoverable: the wallet-level
    // catch swallows it, nothing was persisted, and every later tick restarts at
    // page 1 and dies in the same place — so no deposit beyond page 1 can ever
    // reach the audit ledger. Writing here converts that into forward progress:
    // the next tick resumes past the pages that DID succeed.
    await cache.put(cursorKey, cursor, {
      expirationTtl: EARN_DEPOSIT_SWEEP_CURSOR_TTL_SECONDS,
    });
  }

  getLogger().info(
    { walletId: wallet.id, pages },
    "sweepEarnDeposits: page cap reached, resuming next pass"
  );
}

export interface EarnDepositSweepDeps {
  env: Env;
  bg: BackgroundRunner;
  observability?: Observability;
}

export function runEarnDepositSweep(deps: EarnDepositSweepDeps): void {
  const work = () => sweepEarnDeposits(deps.env);

  // Never invoke `work` eagerly — a throw before the first await must become a
  // rejected promise the BackgroundRunner can track, not propagate to the runtime
  // entrypoint.
  const promise = deps.observability
    ? deps.observability.withMonitor(EARN_DEPOSIT_SWEEP_MONITOR, work, {
        schedule: { type: "crontab", value: EARN_DEPOSIT_SWEEP_CRON },
      })
    : Promise.resolve().then(work);

  deps.bg.run(promise);
}

export type EarnDepositSweepTickOutcome = "swept" | "skipped";

/**
 * One tick of the managed Cloud Run Job: claim the cadence slot, then sweep under
 * this task's own Sentry monitor. Ticks that lose the claim skip without a monitor
 * check-in, so Sentry sees check-ins matching EARN_DEPOSIT_SWEEP_CRON rather than
 * the job's five-minute schedule.
 *
 * A failed or deadline-exceeded pass releases the slot — the next tick retries
 * rather than waiting out the window — and rethrows: the sweep already degrades per
 * wallet and per row, so anything escaping it is infrastructure-level. The caller in
 * `src/job.ts` catches it so a sweep failure cannot fail the whole job, but the
 * release happens HERE, before that catch, so a failed pass never holds the slot
 * for its full TTL.
 *
 * Callers gate on isEarnEnabled first, mirroring the in-process registration.
 */
export async function runEarnDepositSweepIfDue(
  env: Env,
  observability?: Observability
): Promise<EarnDepositSweepTickOutcome> {
  const cache = createKVStoreSet(env).cache;
  const claimToken = await claimCronSlot(
    cache,
    EARN_DEPOSIT_SWEEP_SLOT_KEY,
    EARN_DEPOSIT_SWEEP_SLOT_TTL_SECONDS
  );
  if (claimToken === null) {
    getLogger().info("sweepEarnDeposits: cadence slot already claimed, skipping this tick");
    return "skipped";
  }

  // The deadline sits inside the monitor wrapper so Sentry records an exceeded run
  // as a failed check-in rather than a forever-pending one.
  const work = () =>
    withCronDeadline(
      sweepEarnDeposits(env),
      EARN_DEPOSIT_SWEEP_DEADLINE_SECONDS,
      "earn deposit sweep"
    );
  try {
    await (observability
      ? observability.withMonitor(EARN_DEPOSIT_SWEEP_MONITOR, work, {
          schedule: { type: "crontab", value: EARN_DEPOSIT_SWEEP_CRON },
        })
      : work());
  } catch (err) {
    await releaseCronSlot(cache, EARN_DEPOSIT_SWEEP_SLOT_KEY, claimToken, "sweepEarnDeposits");
    throw err;
  }
  return "swept";
}
