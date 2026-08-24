import {
  EARN_DEPOSIT_TOKEN_SYMBOLS,
  type EarnDepositTokenSymbol,
  WELL_KNOWN_TOKEN_BY_MINT,
} from "@sdp/types";
import { providerUnavailable } from "../../errors";
import { providerFetchJson } from "../../fetch";
import type {
  EarnDeclaredStrategySupport,
  EarnLiveMetricsProvider,
  EarnRuntimeContext,
  ProviderStrategyMetrics,
  ProviderStrategySnapshot,
} from "../../types";
import { StubEarnClient } from "../stub";
import { listKaminoDevnetVaults } from "./devnet";

/**
 * Kamino's public data API. No credential: unlike every other Earn provider
 * this is an open read-only API, which is why there is no `KAMINO_API_KEY` and
 * why `readKaminoConfig`-style credential resolution does not exist here. The
 * "missing API key ⇒ PROVIDER_NOT_CONFIGURED before any network call"
 * invariant (ADR 0002) is vacuous for a provider with no key — nothing about
 * Kamino can be mis-configured into reaching a wrong account.
 */
const KAMINO_API_URL = "https://api.kamino.finance";

/**
 * The cluster the REST shelf at `api.kamino.finance` indexes.
 *
 * Scoped to the production path ONLY — `_listDevnetStrategies` stamps `devnet`
 * for every other environment, proving the chain by genesis hash first.
 *
 * An earlier revision of this comment asserted "K-Vaults are deployed on
 * MAINNET ONLY … there is no devnet deployment" as measured fact. It was
 * wrong (Kamino runs `devkRng…` on devnet with 21 vaults — see ./devnet.ts),
 * and it cost a sandbox shelf where every row was permanently
 * `fundable: false`. What made the error durable is that the API ACCEPTS
 * `?env=devnet` and returns a byte-identical mainnet payload, so the probe that
 * "confirmed" mainnet-only could not have failed.
 */
const KAMINO_HOST_CLUSTER = "mainnet-beta" as const;

/**
 * Minimum vault TVL, in USD, to enter the catalogue.
 *
 * Kamino's vault registry is permissionless, so `GET /kvaults/vaults` is a
 * census of everything ever created rather than a curated shelf. Measured
 * 2026-08-13: 170 vaults total, 114 in SDP's three stablecoins, and roughly 90
 * of those 114 are dust or literal test vaults — `testfail4`, `vkjm_test`,
 * `silviu test vault`, `4dsfda`, plus 8 with blank names.
 *
 * The distribution has a natural cliff: 21 vaults hold $100k or more, the next
 * one down holds $1,023, and below that it is test fixtures all the way. The
 * floor sits at the top of that cliff. It is a one-line tune, and because it
 * reads live TVL it self-heals in both directions — a launching vault appears
 * once it takes real deposits, a draining one leaves via the sync's delist
 * pass.
 *
 * `pnpm -C apps/sdp-api earn:inventory:kamino` regenerates the census in
 * docs/earn/kamino-catalogue-inventory.md, which is how a change to this number
 * gets reviewed against what it admits and refuses.
 */
export const KAMINO_MIN_TVL_USD = 100_000;

/*
 * A K-VAULT NAME IS ATTACKER-CONTROLLED. SDP MUST NOT ASSERT ANYTHING FROM IT.
 *
 * (A standing rule for this file rather than doc for one symbol — the point is
 * the code that is ABSENT.)
 *
 * Vault creation is permissionless — `KaminoManager.createVaultIxs` in Kamino's
 * own SDK — and the name is a free-text field the creator picks. The live shelf
 * proves it: "PC Test Vault Dawid" sits there beside the real houses.
 *
 * So the name may be RENDERED (it is what Kamino calls the vault, presented as
 * such) but it may never be PARSED into a structured claim, because a
 * structured claim is SDP vouching rather than quoting:
 *
 * - **No curator derivation.** Kamino publishes no curator field on any
 *   endpoint, so there is nothing to attribute from. An earlier revision matched
 *   a house list against the name and fell back to `kamino` — which meant
 *   anyone could mint a vault called "Steakhouse USDC Prime", clear the TVL
 *   floor for one hourly sync, and have SDP print Steakhouse's name on it. The
 *   floor is a cost, not an authorization. `riskMetadata.curator` is therefore
 *   OMITTED, and the dashboard already renders a missing curator as absent.
 * - **No RWA classification.** Every vault is catalogued `defi`, which is what a
 *   K-Vault verifiably is: it allocates into Klend reserves. An earlier revision
 *   read `rwa`/`private credit`/`commodity` out of the name, which let a chosen
 *   string move a vault into the `sourceKind=rwa` filter — the one filter an
 *   integrator uses to find instruments with real-world backing.
 *
 * Populating either one needs a source Kamino does not currently expose:
 * verified authority/address data, or an audited vault-address allowlist. Add
 * that first; do not re-derive from the name.
 */

// --- Kamino wire shapes (api.kamino.finance, verified 2026-08-13) ---

interface KaminoVaultState {
  /** On-chain vault label. May be blank — 8 vaults carry an empty name. */
  name?: string | null;
  /** Mint accepted for deposit. Mainnet addresses, always. */
  tokenMint: string;
  /** Mint of the kVault share token. Present on every vault observed. */
  sharesMint?: string | null;
  managementFeeBps?: number | null;
  performanceFeeBps?: number | null;
}

export interface KaminoVault {
  /** Vault pubkey — the catalogue's `providerReference`. */
  address: string;
  state: KaminoVaultState;
}

/**
 * One row of `GET /kvaults/vaults/metrics`. Every numeric is a decimal STRING,
 * often at absurd precision (`apy` runs to 21 places), so nothing here is
 * parsed into a float before it has to be.
 */
export interface KaminoVaultMetrics {
  /** Vault pubkey this row describes — the join key back to `KaminoVault`. */
  kvault: string;
  /** Current blended APY as a decimal fraction string ("0.0592…" = 5.92%). */
  apy?: string | null;
  /** Idle balance, USD. */
  tokensAvailableUsd?: string | null;
  /** Balance deployed into Klend reserves, USD. */
  tokensInvestedUsd?: string | null;
  numberOfHolders?: number | null;
}

interface KaminoMetricsPage {
  result: KaminoVaultMetrics[];
  paginationToken?: string | null;
}

/** `limit` is capped at 100 by the endpoint; ask for the maximum. */
const KAMINO_METRICS_PAGE_SIZE = 100;

/**
 * Hard stop on the metrics pagination loop. The shelf is ~170 vaults over two
 * pages; twenty is unreachable in practice and exists so a server that always
 * echoes a `paginationToken` cannot spin the sync until its deadline.
 *
 * Reaching it is an ERROR, not a quiet truncation — see `_loadMetricsByVault`.
 * A partial metrics map would silently delist every vault it failed to read.
 */
const KAMINO_METRICS_MAX_PAGES = 20;

/**
 * Per-request ceiling. Both of this client's callers are scheduled jobs that
 * await their steps in sequence, so an unbounded read here is not a slow
 * failure — it spends the whole execution and the steps after it never run.
 *
 * Sized against the tightest of them: the reconciliation job's Cloud Run
 * timeout is 120s (`sdp_api_cron_timeout`), and the metrics refresh runs FIRST,
 * before `runEarnCatalogueSyncIfDue`. Measured, the full pass is ~1.4s for four
 * requests, so 10s is roughly seven times the observed worst case and still
 * leaves the rest of the job its budget. `EARN_PROVIDER_METRICS_DEADLINE_MS`
 * (apps/sdp-api/src/cron/earn-metrics-refresh.ts) is the outer bound on the
 * whole per-provider pass, which is what caps the pagination loop.
 */
const KAMINO_REQUEST_TIMEOUT_MS = 10_000;

// --- Normalization helpers ---

/**
 * Plain decimal, NO exponent — the shape `truncateKaminoApy` can slice.
 *
 * Deliberately narrower than what Kamino's numeric strings can be (see
 * `kaminoUsd`): a rate is truncated by string surgery, so `1e-7` has no digit
 * at the position the slice would cut and must be refused rather than
 * mis-read. Every `apy` observed on the live shelf is plain decimal.
 */
const KAMINO_PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * Parse a USD figure from Kamino, accepting the FULL numeric grammar it emits.
 *
 * Kamino serializes small balances in exponent form — `tokensAvailableUsd`
 * comes back as `"9.9984972e-7"` on 28 of the 173 vaults on the live shelf —
 * so the plain-decimal regex above would silently read those as "no value" and
 * drop a real balance out of the vault's TVL. These are money figures headed
 * for a float sum and a size comparison, not for string surgery, so `Number`
 * is the right parser; the guards reject the two inputs it gets wrong
 * (`Number("")` is 0, and `Infinity` is not a size).
 */
function kaminoUsd(value: string | null | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** APY decimal places kept. Six is a hundredth of a basis point — well past
 * anything a rate display or a yield calculation needs, and it keeps the stored
 * string comparable with Ground's bps-derived values. */
const APY_DECIMAL_PLACES = 6;

/**
 * Add one unit at the last retained decimal place of a magnitude, carrying by
 * hand. `digits` is the integer part concatenated with the fractional part
 * padded to exactly `APY_DECIMAL_PLACES`, so "0012345" (0.012345) → "0012346",
 * and "0999999" (0.999999) → "1000000".
 *
 * Long addition on a string, because the whole point is that no float touches a
 * rate: `0.012345 + 0.000001` is not `0.012346` in a double.
 */
function bumpLastPlace(digits: string): string {
  const out = [...digits];
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i] === "9") {
      out[i] = "0";
      continue;
    }
    out[i] = String(Number(out[i]) + 1);
    return out.join("");
  }
  // Every digit carried — the magnitude gained a place (0.999999 → 1.000000).
  return `1${out.join("")}`;
}

/**
 * Kamino sends rates as decimal strings up to 21 places
 * (`"0.05925349346419595"`). Cut them to `APY_DECIMAL_PLACES` by STRING
 * SURGERY, never by `Number()` — the package rule is that no float touches a
 * rate, and a round-trip through a double silently re-renders the tail it
 * cannot hold.
 *
 * The invariant is directional, not "truncate": **SDP never quotes a rate above
 * the one the provider reported.** For a positive rate that means dropping the
 * tail. For a NEGATIVE rate — four vaults on the current shelf report one, and a
 * vault genuinely losing value must not be shown as flat — dropping the tail
 * moves the number UP (`-0.0123456789` → `-0.012345`, and a sub-precision loss
 * → `0`), which is the opposite of the invariant. So a negative value with a
 * non-zero discarded tail is floored AWAY from zero instead: `-0.012346`, and
 * `-0.0000000001` → `-0.000001`, the smallest loss this precision can express.
 * A negative value whose tail is all zeros is already exact and is left alone.
 *
 * Anything unparseable answers undefined, which renders as "no rate yet" rather
 * than a fabricated 0%.
 */
export function truncateKaminoApy(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !KAMINO_PLAIN_DECIMAL.test(trimmed)) {
    return undefined;
  }
  const point = trimmed.indexOf(".");
  if (point === -1) {
    return trimmed;
  }

  const negative = trimmed.startsWith("-");
  const magnitude = negative ? trimmed.slice(1) : trimmed;
  const [whole = "0", fraction = ""] = magnitude.split(".");
  const kept = fraction.slice(0, APY_DECIMAL_PLACES);
  const discarded = fraction.slice(APY_DECIMAL_PLACES);

  let digits = whole + kept.padEnd(APY_DECIMAL_PLACES, "0");
  if (negative && /[1-9]/.test(discarded)) {
    digits = bumpLastPlace(digits);
  }

  const cut = digits.length - APY_DECIMAL_PLACES;
  const rebuilt = `${digits.slice(0, cut)}.${digits.slice(cut)}`.replace(/\.?0+$/, "");
  // A positive value smaller than the retained precision cuts to "" or "0";
  // report the zero rather than an empty string or a signed zero.
  return rebuilt === "" || rebuilt === "0" ? "0" : `${negative ? "-" : ""}${rebuilt}`;
}

/**
 * Vault TVL: idle balance plus what is deployed into reserves. Returns
 * undefined when neither figure parses, which the distillation treats as
 * "TVL unprovable" and drops — a vault we cannot size cannot clear a size
 * floor.
 *
 * Exported for the catalogue-inventory script, which prints the TVL beside each
 * row: the census must report the same number the admission gate judged, so it
 * shares this rather than re-deriving it (same reason Ground exports
 * `classifySourceKind`/`deriveCurator`).
 */
export function kaminoTvlUsd(metrics: KaminoVaultMetrics): number | undefined {
  const parts = [metrics.tokensAvailableUsd, metrics.tokensInvestedUsd].map(kaminoUsd);
  if (parts.every((part) => part === undefined)) {
    return undefined;
  }
  const total = parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);
  return Number.isFinite(total) ? total : undefined;
}

// --- Distillation ---

/** Why distillation kept a raw Kamino vault out of the strategy catalogue. */
export type KaminoCatalogueDropReason =
  | "unknown_deposit_mint"
  | "not_a_deposit_token"
  | "unnamed"
  | "no_metrics"
  | "below_tvl_floor";

export type KaminoVaultDistillation =
  | { outcome: "catalogued"; snapshot: ProviderStrategySnapshot }
  | { outcome: "dropped"; reason: KaminoCatalogueDropReason };

const KAMINO_DEPOSIT_SYMBOLS: ReadonlySet<string> = new Set(EARN_DEPOSIT_TOKEN_SYMBOLS);

/**
 * Distill one raw Kamino vault into a catalogue snapshot, or say exactly why it
 * stays out. The single decision point for what enters the catalogue:
 * `listStrategies` collects the catalogued outcomes and the inventory script
 * (apps/sdp-api/scripts/inventory-kamino-catalogue.ts) reports the dropped
 * ones. These gates refuse 93 of 114 stablecoin vaults, so coverage questions
 * need the drops enumerated, not skipped.
 *
 * Gate order is chosen to make the census legible: token gates first (they
 * describe the shelf), then shape, then size. Reordering changes which reason a
 * vault is attributed to, not whether it is admitted.
 */
/**
 * Is this mint one SDP Earn actually fronts?
 *
 * Shared by both cluster paths so the answer cannot drift between them, and
 * mint-keyed rather than symbol-keyed because `WELL_KNOWN_TOKEN_BY_MINT` already
 * carries the per-cluster addresses — devnet USDC and mainnet USDC are different
 * mints for the same symbol.
 */
function isSupportedKaminoDepositMint(mint: string): boolean {
  const token = WELL_KNOWN_TOKEN_BY_MINT.get(mint);
  return token !== undefined && KAMINO_DEPOSIT_SYMBOLS.has(token.symbol);
}

export function distillKaminoVault(
  vault: KaminoVault,
  metrics: KaminoVaultMetrics | undefined
): KaminoVaultDistillation {
  // The mint is read from the vault's own on-chain state, never resolved from a
  // symbol against a cluster the way Ground's is: Kamino states the exact mint
  // it accepts, and it is always a mainnet address.
  const token = WELL_KNOWN_TOKEN_BY_MINT.get(vault.state.tokenMint);
  if (token === undefined) {
    return { outcome: "dropped", reason: "unknown_deposit_mint" };
  }
  // Screened here rather than left to `isStrategyWithinDeclaredSupport`, which
  // would also refuse it: the catalogue sync logs a warning per snapshot
  // outside declared support, and Kamino's 56 non-stablecoin vaults (SOL, USDS,
  // PYUSD, cbBTC…) would emit that warning every hour in both environments
  // forever. Provider drift deserves a warning; a shelf we knowingly only cover
  // part of does not.
  if (!KAMINO_DEPOSIT_SYMBOLS.has(token.symbol)) {
    return { outcome: "dropped", reason: "not_a_deposit_token" };
  }
  const name = vault.state.name?.trim();
  if (!name) {
    return { outcome: "dropped", reason: "unnamed" };
  }
  // Fail closed on a missing metrics row: TVL is the admission test, and a
  // vault whose size cannot be established has not passed it. This also keeps a
  // partial metrics response from admitting the whole shelf.
  if (metrics === undefined) {
    return { outcome: "dropped", reason: "no_metrics" };
  }
  const tvlUsd = kaminoTvlUsd(metrics);
  if (tvlUsd === undefined || tvlUsd < KAMINO_MIN_TVL_USD) {
    return { outcome: "dropped", reason: "below_tvl_floor" };
  }

  const shareMint = vault.state.sharesMint?.trim();
  return {
    outcome: "catalogued",
    snapshot: {
      providerReference: vault.address,
      name,
      // Always `defi`, never read out of the name — see the trust-boundary note
      // above. A K-Vault allocates into Klend reserves, which IS DeFi lending;
      // that is the one classification the vault's own mechanics establish.
      sourceKind: "defi",
      // Every K-Vault deploys into Klend reserves — that is what a K-Vault is.
      underlyingSource: "klend",
      depositMints: [vault.state.tokenMint],
      ...(shareMint ? { shareMint } : {}),
      hostCluster: KAMINO_HOST_CLUSTER,
      apyType: "variable",
      currentApy: truncateKaminoApy(metrics.apy),
      // A K-Vault withdrawal is atomic in one transaction and auto-disinvests
      // from a Klend reserve when the vault's idle balance is short — Kamino's
      // withdraw docs are explicit, and there is no redemption queue and no
      // day-denominated delay to report. A fully-utilised underlying reserve
      // can still stall an exit, but that is a liquidity CONDITION at the
      // moment of withdrawal, not a redemption TERM of the vault, and the
      // snapshot has no field that could honestly carry it.
      liquidityTerm: "instant",
      // No `curator` — Kamino publishes none, and the name cannot stand in for
      // one (see the trust-boundary note above). Everything here is a figure
      // the protocol itself reports.
      riskMetadata: {
        tvlUsd,
        ...(metrics.numberOfHolders == null ? {} : { holders: metrics.numberOfHolders }),
        ...(vault.state.managementFeeBps == null
          ? {}
          : { managementFeeBps: vault.state.managementFeeBps }),
        ...(vault.state.performanceFeeBps == null
          ? {}
          : { performanceFeeBps: vault.state.performanceFeeBps }),
      },
    },
  };
}

/**
 * Kamino vault-infra client — REST on mainnet, on-chain on devnet.
 *
 * CATALOGUE-ONLY, and that is the integration, not a stage of it. Kamino is
 * non-custodial: a K-Vault is an on-chain vault the customer's own wallet
 * deposits into, so there is no omnibus wallet for SDP to provision, fund, or
 * pay out from. It therefore implements the base `EarnVaultProvider` contract
 * and NONE of the optional capabilities — every portfolio and withdrawal route
 * answers 501 for it through `supportsPortfolioWallets`, never through a
 * provider-id check.
 *
 * Two facts shape everything else here (measured 2026-08-14):
 *
 * - **No API credential.** The REST shelf is public — there is no
 *   `KAMINO_API_KEY` anywhere. The one `ctx.env` read is `SOLANA_RPC_URL`, on
 *   the devnet path, and a blank one fails closed with
 *   PROVIDER_NOT_CONFIGURED rather than silently emptying the shelf.
 * - **Two clusters, two SOURCES.** `ctx.environment` selects between them:
 *   production reads the mainnet REST shelf (`hostCluster: "mainnet-beta"`),
 *   every other environment reads the devnet kvault program on-chain
 *   (`./devnet.ts`, `hostCluster: "devnet"`). Non-production issues no request
 *   to api.kamino.finance at all, which is stronger than fetching and
 *   filtering — and the catalogue sync independently refuses to persist a
 *   mainnet instrument outside production, so a bug here cannot put one in a
 *   sandbox database.
 *
 * The predecessor of this comment said "mainnet only … `ctx.environment` is
 * deliberately unused for data selection". Treat that as the cautionary tale it
 * is: it was recorded as a live-API measurement, and the API's habit of
 * accepting-and-ignoring `?env=devnet` meant no amount of re-probing it would
 * have caught the error. The chain would have.
 */
export class KaminoEarnClient extends StubEarnClient implements EarnLiveMetricsProvider {
  readonly provider = "kamino" as const;
  readonly declaredSupport: EarnDeclaredStrategySupport = {
    // `defi` only. Vaults with real-world backing do exist on the shelf, but
    // Kamino exposes no field that establishes one — only the permissionless
    // name, which SDP does not parse (see the trust-boundary note above). The
    // envelope states what this client can honestly emit, so it stays at one
    // kind until a verified source for the other lands.
    sourceKinds: ["defi"],
    // Kamino's vaults span SOL, USDS, PYUSD, cbBTC and more; SDP Earn V1 is a
    // stablecoin deposit facility, so the envelope stays at the three symbols
    // `EARN_DEPOSIT_TOKEN_SYMBOLS` declares. Widening this is a change to that
    // shared union, not to this client.
    depositTokens: [...EARN_DEPOSIT_TOKEN_SYMBOLS] as EarnDepositTokenSymbol[],
  };

  /**
   * The raw vault registry, unfiltered. Data source for `listStrategies`, and
   * the tooling surface the catalogue-inventory script reads so it can report
   * what distillation drops (underscore-prefixed like Ground's
   * `_iterateYieldSources`: a real consumer exists, but this is not part of the
   * provider contract).
   */
  async _listVaults(): Promise<KaminoVault[]> {
    return await providerFetchJson<KaminoVault[]>(
      this.provider,
      `${KAMINO_API_URL}/kvaults/vaults`,
      {
        method: "GET",
        timeoutMs: KAMINO_REQUEST_TIMEOUT_MS,
      }
    );
  }

  /**
   * Current metrics for every vault, keyed by address.
   *
   * The BULK endpoint is what makes this integration cheap: the per-vault
   * `/kvaults/vaults/{pubkey}/metrics` route would be one request per vault
   * (170 today) on every sync, in both environments, every hour. This is two.
   *
   * ALL-OR-NOTHING, and that is the important property. A vault with no metrics
   * row is dropped from the catalogue (`no_metrics`), and the sync DELETES rows
   * a provider no longer lists — so a half-read shelf would not degrade, it
   * would delist every vault whose page went missing. Both truncation paths
   * therefore throw rather than return a short map: the sync's per-provider
   * catch then skips the pass entirely and the catalogue is left intact.
   */
  async _loadMetricsByVault(): Promise<Map<string, KaminoVaultMetrics>> {
    const byVault = new Map<string, KaminoVaultMetrics>();
    let paginationToken: string | null = null;
    let page = 0;

    do {
      const url = new URL("/kvaults/vaults/metrics", KAMINO_API_URL);
      url.searchParams.set("limit", String(KAMINO_METRICS_PAGE_SIZE));
      if (paginationToken) {
        url.searchParams.set("paginationToken", paginationToken);
      }
      const response: KaminoMetricsPage = await providerFetchJson(this.provider, url.toString(), {
        method: "GET",
        timeoutMs: KAMINO_REQUEST_TIMEOUT_MS,
      });
      // A 200 whose body carries no `result` array is a malformed page, not an
      // empty one — providerFetchJson does no schema validation, so `{}` would
      // otherwise sail through as "this page had zero vaults". An empty array
      // is legitimate and still ends the walk via the token below.
      if (!Array.isArray(response.result)) {
        throw providerUnavailable("Kamino returned a metrics page with no result array");
      }
      for (const metrics of response.result) {
        if (metrics.kvault) {
          byVault.set(metrics.kvault, metrics);
        }
      }
      paginationToken = response.paginationToken ?? null;
      page += 1;
    } while (paginationToken && page < KAMINO_METRICS_MAX_PAGES);

    // A live token at the cap means the shelf is unfinished — refuse it rather
    // than answer with a partial map (see this method's doc).
    if (paginationToken) {
      throw providerUnavailable(
        `Kamino metrics pagination exceeded ${KAMINO_METRICS_MAX_PAGES} pages; refusing a partial shelf`
      );
    }

    return byVault;
  }

  /**
   * The shelf, per environment — and the two environments read DIFFERENT
   * SOURCES, not the same source with a parameter.
   *
   * - **production** → the REST API, which indexes mainnet only.
   * - **anything else** → devnet, read on-chain (`./devnet.ts`).
   *
   * Non-production NEVER returns a mainnet vault. That is a hard requirement,
   * not a preference: a mainnet row in a sandbox catalogue is an instrument a
   * devnet wallet cannot reach, and before this split every sandbox Kamino row
   * was exactly that — catalogued, permanently `fundable: false`, and useless
   * to an integrator. The catalogue sync enforces the same rule independently
   * (an inline `hostCluster`/environment check in `syncProviderCatalogue`), so a bug here cannot put
   * mainnet rows in a sandbox database.
   */
  override async listStrategies(ctx: EarnRuntimeContext): Promise<ProviderStrategySnapshot[]> {
    if (ctx.environment !== "production") {
      return await this._listDevnetStrategies(ctx);
    }

    // Both reads are issued together: they are independent, and the vault list
    // alone cannot produce a snapshot (TVL and APY live only in metrics).
    const [vaults, metricsByVault] = await Promise.all([
      this._listVaults(),
      this._loadMetricsByVault(),
    ]);

    const snapshots: ProviderStrategySnapshot[] = [];
    for (const vault of vaults) {
      const distilled = distillKaminoVault(vault, metricsByVault.get(vault.address));
      if (distilled.outcome === "catalogued") {
        snapshots.push(distilled.snapshot);
      }
    }
    return snapshots;
  }

  /**
   * Devnet vaults, from the chain.
   *
   * Two admission rules differ from mainnet's, and both follow from devnet
   * having no economics rather than from a relaxed standard:
   *
   * - **No TVL floor.** `KAMINO_MIN_TVL_USD` exists to separate a real shelf
   *   from a permissionless census of dust and test vaults, using size as the
   *   proxy for seriousness. Devnet deposits are play money, so size measures
   *   nothing there; applying the floor would empty the shelf entirely.
   *   `declaredSupport` (stablecoin mints only) is what does the filtering.
   * - **No APY.** The metrics endpoint 404s for devnet vaults, so rows carry no
   *   rate and the dashboard renders "—". That is honest — a devnet rate would
   *   be a fiction — and it is why the live-metrics refresh also skips
   *   non-production (see `getStrategyMetrics`).
   */
  async _listDevnetStrategies(ctx: EarnRuntimeContext): Promise<ProviderStrategySnapshot[]> {
    const rpcUrl = ctx.env.SOLANA_RPC_URL ?? "";
    const vaults = await listKaminoDevnetVaults(rpcUrl);

    return (
      vaults
        // Screened HERE rather than left to `isStrategyWithinDeclaredSupport`,
        // which would also refuse them — same reason the mainnet path screens in
        // `distillKaminoVault`: the sync logs a warning per out-of-envelope
        // snapshot, and devnet's shelf is roughly half SOL and bespoke test mints,
        // so passing them through would emit ~11 warnings every hourly pass in
        // perpetuity. Provider drift is worth a warning; a vault in an asset SDP
        // never claimed to front is not drift.
        .filter((vault) => isSupportedKaminoDepositMint(vault.tokenMint))
        .map((vault) => ({
          providerReference: vault.address,
          name: vault.name,
          // Same reasoning as mainnet: a K-Vault allocates into Klend reserves, and
          // that is the one classification its own mechanics establish. Never read
          // out of the attacker-chosen name.
          sourceKind: "defi" as const,
          underlyingSource: "klend",
          depositMints: [vault.tokenMint],
          shareMint: vault.sharesMint,
          // Not derived from `ctx.environment`: `listKaminoDevnetVaults` proves the
          // chain by genesis hash before returning a single vault, so this states
          // the cluster we measurably read. Deriving it from the environment is the
          // silent lie migration 0057 exists to prevent.
          hostCluster: "devnet" as const,
          apyType: "variable" as const,
          liquidityTerm: "instant" as const,
          riskMetadata: {},
        }))
    );
  }

  /**
   * Live figures for the whole shelf — the short-cadence half of the catalogue.
   *
   * Kamino is a natural fit for this capability: `apy` moves continuously with
   * the underlying Klend reserve rates, and the BULK metrics endpoint carries
   * every figure for every vault in two requests. There is no vault-list fetch
   * here at all (the 348KB call `listStrategies` makes) because none of what it
   * returns can change between hourly syncs — name, mints and share mint are
   * on-chain identity.
   *
   * Reports figures for every vault Kamino knows, including ones distillation
   * refused. That is deliberate and safe: the refresh only UPDATEs rows the
   * catalogue already holds, so an unknown reference is a no-op, and filtering
   * here would mean re-fetching the vault list to re-run the gates.
   */
  async listStrategyMetrics(ctx: EarnRuntimeContext): Promise<ProviderStrategyMetrics[]> {
    // PRODUCTION ONLY, for the same reason `listStrategies` splits: the metrics
    // endpoint is the mainnet API's, and it 404s for a devnet vault pubkey
    // (measured 2026-08-14). Calling it outside production would spend two
    // requests every five minutes to build a map keyed by MAINNET references —
    // which `updateStrategyMetrics` then matches against a devnet catalogue and
    // no-ops on, every single pass. Empty is the honest answer, and it is why a
    // sandbox row renders no rate rather than a fabricated one.
    if (ctx.environment !== "production") {
      return [];
    }

    const metricsByVault = await this._loadMetricsByVault();

    return [...metricsByVault.values()].map((metrics) => {
      const tvlUsd = kaminoTvlUsd(metrics);
      return {
        providerReference: metrics.kvault,
        currentApy: truncateKaminoApy(metrics.apy),
        riskMetadata: {
          ...(tvlUsd === undefined ? {} : { tvlUsd }),
          ...(metrics.numberOfHolders == null ? {} : { holders: metrics.numberOfHolders }),
        },
      };
    });
  }
}
