import type { EarnVaultDepositQuoteIssue } from "@sdp/earn/types";
import {
  addDecimalAmounts,
  compareDecimalAmounts,
  isDecimalString,
  scaleDecimalAmountByBps,
} from "@sdp/solana/amount";
import type { EarnProviderId, SdpEnvironment, SolanaCluster } from "@sdp/types";
import type { Context } from "hono";
import { type AppDb, asTransactionalClient, type DatabaseExecutor, getDb } from "@/db";
import type { EarnStrategyRow } from "@/db/repositories/earn.repository";
import { createPostgresEarnRepository } from "@/db/repositories/earn.repository.postgres";
import { createPostgresEarnMovementsRepository } from "@/db/repositories/earn-movements.repository";
import { serviceUnavailable, vaultExposureCapExceeded } from "@/lib/errors";
import { isEarnVolumeCapsEnforced } from "@/lib/feature-flags";
import { resolveSdpEnvironment } from "@/lib/sdp-environment";
import {
  DEFAULT_VAULT_EXPOSURE_CAP,
  VAULT_EXPOSURE_CAPS,
  type VaultExposureCap,
} from "@/routes/earn/handlers/curation";
import { describeError, logEvent } from "@/runtime/money-path-events";
import type { Env } from "@/types/env";
import { earnClusterFor } from "./execution-registry";

/**
 * ADR 0004, layer 1: SDP-wide exposure per vault, checked at deposit admission.
 *
 * Bounds how much SDP's customers may COLLECTIVELY hold in one vault, so one
 * vault's exploit, depeg or liquidity crunch costs SDP customers at most a
 * known number, and SDP stays a small enough share of any vault that its
 * customers can always leave (EARN-015). The config is curation-as-code beside
 * `CURATED_VAULTS` (`handlers/curation.ts`).
 *
 * The cap is decided TWICE per deposit, on purpose:
 *
 * 1. **Admission** (`assertVaultExposureWithinCap`), the LAST step of the single
 *    money-in predicate (`assertVaultDepositAdmissible`), before anything is
 *    built or signed. Reads the ledger fresh. This is the refusal a caller
 *    hears early and the figure the preview reports.
 * 2. **Ledger write** (`ledgerVaultExposureGate`), inside the transaction that
 *    records the deposit's `requested` row, under the ledger's per-vault
 *    transaction advisory lock (`earnVaultDepositWriteLockKey`). Two deposits
 *    admitted a moment apart each read the same headroom at step 1; only a
 *    check serialized at the write, on committed rows, can refuse the second.
 *    The lock is transaction-scoped, so it is held for the write and released
 *    with it, and the aggregate runs on the same connection
 *    (`earn_vault_deposit_exposure`, migration 0101) so nothing waits on a
 *    second pooled connection while holding the lock.
 *
 * Both halves emit the same event with a `stage`, so shadow data can tell an
 * early refusal from a race caught at the write.
 *
 * Posture, in the ADR's words:
 * - **Deposits only.** Nothing here is ever consulted on a withdrawal (ADR
 *   0002: exits never trap funds). A vault over its cap is exit-only.
 * - **Shadow first.** `EARN_VOLUME_CAPS_ENFORCED` off (the default) evaluates
 *   and emits `sdp_api_earn_volume_cap_evaluated` with `would_block`, refuses
 *   nothing, and the preview does NOT report a blocking issue: a preview that
 *   says "blocked" while the deposit lands is a lie.
 * - **Fail closed on the inputs, in every mode.** An exposure read that
 *   throws refuses the deposit with a 503, shadow mode included. Same posture
 *   as a database outage today.
 *
 * Units: the vault's DEPOSIT-TOKEN units throughout (no price oracle; every V1
 * vault is a dollar stablecoin). The catalogue TVL is USD, so the share bound
 * compares token units against dollars, which for a stablecoin vault is the
 * same approximation. A swap-funded deposit's `amount` is in the SOURCE
 * stablecoin's units, one more dollar-for-dollar approximation of the same
 * kind. See `VaultExposureCap` for the full statement.
 */

/** The `blockingIssues` code the deposit preview reports for this cap. */
export const VAULT_EXPOSURE_CAP_ISSUE_CODE = "VAULT_EXPOSURE_CAP";

/** The structured event every evaluation emits, blocked or not. */
export const EARN_VOLUME_CAP_EVALUATED_EVENT = "sdp_api_earn_volume_cap_evaluated";

/** How long one vault's exposure figure is reused before the ledger is re-read. */
export const VAULT_EXPOSURE_CACHE_TTL_MS = 30_000;

/**
 * Which step evaluated: a preview (cached read, never refuses), the admission
 * gate before the build (fresh read), or the ledger write under its lock.
 */
export type VaultExposureStage = "preview" | "admission" | "ledger_write";

export interface VaultExposureKey {
  environment: SdpEnvironment;
  provider: string;
  vaultAddress: string;
}

export interface VaultExposureEvaluation {
  /** True when admitting `amount` would push SDP-wide holdings past the cap. */
  wouldBlock: boolean;
  /** Which bound decided, in words: for the event and the refusal message. */
  reason: string;
  /** The binding ceiling in deposit-token units; null when the vault is uncapped. */
  limit: string | null;
  /** SDP-wide holdings before this deposit, deposit-token units. */
  exposure: string;
  /** `exposure + amount`, the figure compared against `limit`. */
  projected: string;
}

/**
 * The cap for one vault: the explicit entry when there is one (including an
 * explicit `null`, which means uncapped), else the platform default. Absence
 * is NOT uncapped; that asymmetry is the whole reason `null` exists.
 */
export function resolveVaultExposureCap(
  cluster: SolanaCluster,
  provider: string,
  vaultAddress: string
): VaultExposureCap | null {
  const key = `${provider as EarnProviderId}:${vaultAddress}` as const;
  const entries = VAULT_EXPOSURE_CAPS[cluster];
  if (entries && key in entries) {
    return entries[key] ?? null;
  }
  return DEFAULT_VAULT_EXPOSURE_CAP;
}

/**
 * The pure verdict. `tvl` is the catalogue's USD figure as a decimal string,
 * or null when the row carries none (devnet rows never do); without one the
 * absolute ceiling stands alone and the reason says so, because a cap that
 * silently became looser is the failure this exists to prevent.
 *
 * `wouldBlock` is strict: a deposit landing EXACTLY on the ceiling is admitted.
 */
export function evaluateVaultExposure(input: {
  cap: VaultExposureCap | null;
  exposure: string;
  tvl: string | null;
  amount: string;
}): VaultExposureEvaluation {
  const projected = addDecimalAmounts(input.exposure, input.amount);
  if (input.cap === null) {
    return {
      wouldBlock: false,
      reason: "uncapped",
      limit: null,
      exposure: input.exposure,
      projected,
    };
  }

  let limit = input.cap.maxAbsolute;
  let reason = "absolute";
  if (input.tvl !== null && isDecimalString(input.tvl)) {
    const shareLimit = scaleDecimalAmountByBps(input.tvl, input.cap.maxShareOfTvlBps);
    if (compareDecimalAmounts(shareLimit, limit) < 0) {
      limit = shareLimit;
      reason = "share_of_tvl";
    }
  } else {
    reason = "absolute_tvl_unavailable";
  }

  return {
    wouldBlock: compareDecimalAmounts(projected, limit) > 0,
    reason,
    limit,
    exposure: input.exposure,
    projected,
  };
}

/**
 * The catalogue's TVL for the share bound: `risk_metadata.tvlUsd` when it is a
 * finite non-negative JSON number (the same guard the ranked list applies),
 * else null. Rendered without exponent so it parses as a decimal string.
 */
export function strategyTvlForExposure(
  strategy: Pick<EarnStrategyRow, "risk_metadata">
): string | null {
  const raw = strategy.risk_metadata?.tvlUsd;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
  // `String` renders an exponent above 1e21, which then fails the decimal
  // grammar and reads as "no figure" rather than a wrong one.
  const rendered = String(raw);
  return isDecimalString(rendered) ? rendered : null;
}

type ExposureSum = (db: AppDb, key: VaultExposureKey) => Promise<string>;

interface CacheEntry {
  value: string;
  expiresAt: number;
}

/**
 * A ledger-backed exposure reader with a short in-process cache for PREVIEWS,
 * so a burst of them does not re-aggregate the vault on every keystroke.
 *
 * The cache is advisory only. An ADMISSION reads `fresh`: it bypasses the
 * cache, hits the ledger, and refreshes the cached figure, so an enforced cap
 * is never decided on a stale number. Admission also `reserve`s the admitted
 * amount into the cache, so previews issued right after an admission in the
 * same process already see it. The window between admission and the deposit's
 * own `requested` row landing is closed at the write, not here: the ledger
 * gate re-reads under a per-vault lock (`ledgerVaultExposureGate`). A failed
 * read is never cached. Negative sums cannot come out of the current query (it
 * sums deposits only) but are clamped and logged anyway: a negative figure is
 * ledger drift, and a cap must never be loosened by it.
 */
export function createVaultExposureReader(options: {
  sum: ExposureSum;
  ttlMs?: number;
  now?: () => number;
}) {
  const ttlMs = options.ttlMs ?? VAULT_EXPOSURE_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();

  const cacheKeyOf = (key: VaultExposureKey) =>
    `${key.environment} ${key.provider} ${key.vaultAddress}`;

  return {
    async read(
      db: AppDb,
      key: VaultExposureKey,
      readOptions: { fresh?: boolean } = {}
    ): Promise<string> {
      const cacheKey = cacheKeyOf(key);
      const hit = cache.get(cacheKey);
      if (!readOptions.fresh && hit && hit.expiresAt > now()) {
        return hit.value;
      }
      let value = await options.sum(db, key);
      if (!isDecimalString(value)) {
        // A leading "-" fails the unsigned decimal grammar, which is the one
        // way a SUM over validated amount columns can come back non-decimal.
        logEvent("warn", {
          event: "sdp_api_earn_vault_exposure_negative",
          environment: key.environment,
          provider: key.provider,
          vault_address: key.vaultAddress,
          exposure: value,
        });
        value = "0";
      }
      cache.set(cacheKey, { value, expiresAt: now() + ttlMs });
      return value;
    },
    /**
     * Fold an admitted deposit into the cached figure so previews in this
     * process see it before the ledger row lands. Only bumps a live entry;
     * an expired or absent one is re-read on the next call anyway.
     */
    reserve(key: VaultExposureKey, amount: string): void {
      const cacheKey = cacheKeyOf(key);
      const hit = cache.get(cacheKey);
      if (!hit || hit.expiresAt <= now() || !isDecimalString(amount)) return;
      cache.set(cacheKey, { ...hit, value: addDecimalAmounts(hit.value, amount) });
    },
    clear(): void {
      cache.clear();
    },
  };
}

/**
 * SDP-wide exposure is a cross-tenant fact: under the request's tenant
 * identity row-level security would hide every other organization's deposits
 * and the cap would only ever see the caller's own. The aggregate widens its
 * own read in SQL (`earn_vault_deposit_exposure`, migration 0101, registered
 * in tenant-isolation-coverage.test.ts), so the same figure comes back on a
 * pooled connection and inside a tenant-stamped ledger transaction. It
 * collapses into one number; no other tenant's row reaches the caller.
 */
const ledgerSum: ExposureSum = (db, key) =>
  createPostgresEarnMovementsRepository(db).sumVaultDepositExposure(key);

const defaultReader = createVaultExposureReader({ sum: ledgerSum });

/**
 * SDP-wide exposure to one vault, in deposit-token units. Cached for previews;
 * pass `fresh` for an admission so the enforced verdict reads the ledger.
 */
export function readVaultExposure(
  db: AppDb,
  key: VaultExposureKey,
  options: { fresh?: boolean } = {}
): Promise<string> {
  return defaultReader.read(db, key, options);
}

/** Fold an admitted deposit into the cached exposure (see reader `reserve`). */
export function reserveVaultExposure(key: VaultExposureKey, amount: string): void {
  defaultReader.reserve(key, amount);
}

/** Drops the process-wide exposure cache. Tests only. */
export function resetVaultExposureCacheForTesting(): void {
  defaultReader.clear();
}

export interface VaultExposureVerdict {
  evaluation: VaultExposureEvaluation;
  /** Whether a `wouldBlock` verdict refuses (true) or only reports (false). */
  enforced: boolean;
  /** The vault the verdict is about, for the admission's cache reservation. */
  key: VaultExposureKey;
}

/**
 * Evaluate the cap for one deposit and ALWAYS emit the evaluated event; the
 * caller decides what to do with the verdict. Throws a 503 when the exposure
 * cannot be read, in every enforcement mode.
 */
export async function assessVaultExposure(input: {
  env: Pick<Env, "EARN_VOLUME_CAPS_ENFORCED">;
  environment: SdpEnvironment;
  strategy: Pick<EarnStrategyRow, "provider" | "provider_reference" | "risk_metadata">;
  amount: string;
  stage: VaultExposureStage;
  readExposure: (key: VaultExposureKey) => Promise<string>;
}): Promise<VaultExposureVerdict> {
  const { environment, strategy, amount, stage } = input;
  const enforced = isEarnVolumeCapsEnforced(input.env);
  const cap = resolveVaultExposureCap(
    earnClusterFor(environment),
    strategy.provider,
    strategy.provider_reference
  );
  const tvl = strategyTvlForExposure(strategy);
  const key: VaultExposureKey = {
    environment,
    provider: strategy.provider,
    vaultAddress: strategy.provider_reference,
  };

  let exposure: string;
  try {
    exposure = await input.readExposure(key);
  } catch (error) {
    logEvent("error", {
      event: EARN_VOLUME_CAP_EVALUATED_EVENT,
      cap: "vault_exposure",
      stage,
      environment,
      provider: key.provider,
      vault_address: key.vaultAddress,
      tvl,
      amount,
      enforced,
      ...describeError(error),
      error_message: error instanceof Error ? error.message : String(error),
    });
    // Fail closed on deposits, never on exits (ADR 0004). A cap whose input
    // cannot be read is a cap that cannot be honoured, and admitting on a
    // guess is the one thing the shadow flag must not be able to do.
    throw serviceUnavailable("Vault exposure could not be verified; the deposit was not admitted.");
  }

  const evaluation = evaluateVaultExposure({ cap, exposure, tvl, amount });
  logEvent(evaluation.wouldBlock ? "warn" : "info", {
    event: EARN_VOLUME_CAP_EVALUATED_EVENT,
    cap: "vault_exposure",
    stage,
    environment,
    provider: key.provider,
    vault_address: key.vaultAddress,
    exposure: evaluation.exposure,
    tvl,
    amount,
    projected: evaluation.projected,
    limit: evaluation.limit,
    reason: evaluation.reason,
    would_block: evaluation.wouldBlock,
    enforced,
  });
  return { evaluation, enforced, key };
}

type ExposureContext = Context<{ Bindings: Env }>;

/**
 * Request-scoped form of `assessVaultExposure`. Previews read through the
 * cache; an admission passes `fresh` and reads the ledger. Non-throwing on the
 * verdict; throws 503 on an unreadable exposure.
 */
export function checkVaultExposure(
  c: ExposureContext,
  strategy: EarnStrategyRow,
  amount: string,
  options: { fresh?: boolean } = {}
): Promise<VaultExposureVerdict> {
  return assessVaultExposure({
    env: c.env,
    environment: resolveSdpEnvironment(c),
    strategy,
    amount,
    stage: options.fresh ? "admission" : "preview",
    readExposure: (key) => readVaultExposure(getDb(c.env), key, options),
  });
}

/**
 * The one refusal: a blocking verdict under enforcement is the typed 409;
 * anything else is admitted and folded into the preview cache. Shared by the
 * admission gate and the ledger gate so the two halves cannot disagree on
 * what a verdict means.
 */
function admitOrRefuse(verdict: VaultExposureVerdict, amount: string): VaultExposureVerdict {
  if (verdict.evaluation.wouldBlock && verdict.enforced) {
    throw vaultExposureCapExceeded(
      "This deposit would take SDP's total holdings in the vault past its exposure cap. " +
        "The vault is exit-only for new money until other positions leave; existing positions are unaffected.",
      {
        vaultAddress: verdict.key.vaultAddress,
        limit: verdict.evaluation.limit,
        exposure: verdict.evaluation.exposure,
        projected: verdict.evaluation.projected,
      }
    );
  }
  reserveVaultExposure(verdict.key, amount);
  return verdict;
}

/**
 * The admission step: read the ledger FRESH (never the preview cache),
 * evaluate, emit, and refuse with the typed 409 when the verdict blocks AND
 * caps are enforced. An admitted deposit is reserved into the cache so the
 * next preview in this process sees it. In shadow mode this only ever emits.
 * Never call it on a withdrawal.
 *
 * This is the EARLY half. It runs before the build, so a refused caller pays
 * for no simulation or signing, but it cannot see a deposit admitted a moment
 * earlier whose row has not landed. The ledger write repeats the decision
 * under a lock (`ledgerVaultExposureGate`).
 */
export async function assertVaultExposureWithinCap(
  c: ExposureContext,
  strategy: EarnStrategyRow,
  amount: string
): Promise<VaultExposureVerdict> {
  const verdict = await checkVaultExposure(c, strategy, amount, { fresh: true });
  return admitOrRefuse(verdict, amount);
}

/**
 * The LATE half: the `admit` hook the ledger runs inside the transaction that
 * records a deposit's `requested` row (`LedgerAdmissionHook`,
 * earn-movements.repository.ts). Both deposit paths pass it: the custody
 * deposit from `depositIntoVault`, the external-wallet deposit from
 * `submitExternalWalletDeposit`.
 *
 * Order, and why each step is where it is:
 *
 * 1. The ledger has taken `pg_advisory_xact_lock` on the vault before calling
 *    (`lockVaultDepositWrites`, earn-movements.repository.ts) and re-checked
 *    replay under it. Every writer to this vault, in every process, queues
 *    there until the holder commits or rolls back.
 * 2. Re-read exposure on the SAME connection. READ COMMITTED gives this
 *    statement a fresh snapshot, so the previous holder's committed row is in
 *    the sum; a competing writer that has not yet committed is still queued at
 *    step 1 and will see ours. The aggregate is the SQL function, which widens
 *    its own read, so the tenant-stamped transaction needs no second pooled
 *    connection while it holds the lock (a pool-exhaustion hazard under a
 *    burst to one vault).
 * 3. Evaluate against the catalogue row's cap and TVL, resolved by the identity
 *    the ledger row carries (provider + address + environment). A row delisted
 *    between admission and write evaluates with no TVL, which is the STRICTER
 *    reading (absolute ceiling alone, never a looser share bound).
 * 4. Emit with `stage: "ledger_write"`, and refuse or admit by the same rule as
 *    admission. A refusal throws out of the ledger transaction with nothing
 *    recorded and nothing broadcast: the custody path signed but did not send,
 *    the external-wallet path verified the customer's signature but did not
 *    send. Failing closed there is the ADR's direction; the alternative is a
 *    deposit that lands over the cap.
 *
 * `amount` is what the ledger row records, in the deposit token: for a
 * swap-funded custody deposit that is the derived floor rather than the source
 * amount the admission gate saw, which is the figure the aggregate will sum.
 */
export function ledgerVaultExposureGate(
  env: Env,
  input: { environment: SdpEnvironment; provider: string; vaultAddress: string; amount: string }
): (transaction: DatabaseExecutor) => Promise<void> {
  return async (transaction) => {
    // The repositories on THIS connection, so the catalogue read and the
    // aggregate both run inside the locked transaction.
    const db = asTransactionalClient(transaction);
    const strategy = await createPostgresEarnRepository(db).getStrategyByReference({
      provider: input.provider,
      providerReference: input.vaultAddress,
      environment: input.environment,
    });
    const verdict = await assessVaultExposure({
      env,
      environment: input.environment,
      strategy: strategy ?? {
        provider: input.provider,
        provider_reference: input.vaultAddress,
        risk_metadata: {},
      },
      amount: input.amount,
      stage: "ledger_write",
      readExposure: (exposureKey) => readVaultExposure(db, exposureKey, { fresh: true }),
    });
    admitOrRefuse(verdict, input.amount);
  };
}

/**
 * The preview's `blockingIssues` entry for a blocking verdict, or null. Only
 * an ENFORCED block is reported: in shadow mode the deposit would succeed, and
 * a preview must never claim otherwise.
 */
export function vaultExposureBlockingIssue(
  verdict: VaultExposureVerdict
): EarnVaultDepositQuoteIssue | null {
  if (!(verdict.evaluation.wouldBlock && verdict.enforced)) return null;
  return {
    code: VAULT_EXPOSURE_CAP_ISSUE_CODE,
    message:
      `This deposit would take SDP's total holdings in the vault to ${verdict.evaluation.projected}, ` +
      `past its exposure cap of ${verdict.evaluation.limit}. The vault is exit-only for new money right now.`,
  };
}
