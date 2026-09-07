import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { wellKnownMint } from "@sdp/types";
import type { EarnRuntimeContext } from "../../types";
import {
  distillKaminoVault,
  KAMINO_MIN_TVL_USD,
  KaminoEarnClient,
  type KaminoVault,
  type KaminoVaultMetrics,
  truncateKaminoApy,
} from "./client";

/**
 * Canonical no-network harness (see src/fetch.test.ts): `globalThis.fetch` is
 * stubbed per test and restored in `afterEach` — no test may ever reach the
 * real Kamino API.
 *
 * Note what is NOT here, and is the point of this provider: no API key in
 * either context. Kamino's data API is public, so there is no
 * PROVIDER_NOT_CONFIGURED case to cover — a missing-credential test would be
 * asserting on a credential that does not exist.
 */

const client = new KaminoEarnClient();

const sandboxCtx: EarnRuntimeContext = { env: {}, environment: "sandbox" };
const productionCtx: EarnRuntimeContext = { env: {}, environment: "production" };

const USDC_MAINNET = wellKnownMint("USDC", "mainnet-beta") as string;
const USDG_MAINNET = wellKnownMint("USDG", "mainnet-beta") as string;
const USDC_DEVNET = wellKnownMint("USDC", "devnet") as string;
const SOL_MINT = "So11111111111111111111111111111111111111112";

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status });

/** Queue JSON replies in call order; extra calls replay the last reply. */
function stubKaminoFetch(...replies: Array<{ status?: number; body: unknown }>) {
  let index = 0;
  return mock.method(globalThis, "fetch", async () => {
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return jsonResponse(reply.status ?? 200, reply.body);
  });
}

type FetchMock = ReturnType<typeof stubKaminoFetch>;

const requestUrls = (fetchMock: FetchMock): string[] =>
  fetchMock.mock.calls.map((call) => String(call.arguments[0]));

const vault = (
  overrides: Partial<KaminoVault["state"]> & { address?: string } = {}
): KaminoVault => {
  const { address = "VaULt1111111111111111111111111111111111111", ...state } = overrides;
  return {
    address,
    state: {
      name: "Steakhouse USDC",
      tokenMint: USDC_MAINNET,
      sharesMint: "sHaRe111111111111111111111111111111111111",
      managementFeeBps: 25,
      performanceFeeBps: 0,
      ...state,
    },
  };
};

const metrics = (overrides: Partial<KaminoVaultMetrics> = {}): KaminoVaultMetrics => ({
  kvault: "VaULt1111111111111111111111111111111111111",
  apy: "0.04",
  tokensAvailableUsd: "1000000",
  tokensInvestedUsd: "9000000",
  numberOfHolders: 42,
  ...overrides,
});

/** The two-call shape of one `listStrategies` pass: vault list, then metrics. */
const catalogue = (vaults: KaminoVault[], rows: KaminoVaultMetrics[]) => [
  { body: vaults },
  { body: { result: rows, paginationToken: null } },
];

afterEach(() => {
  mock.restoreAll();
});

describe("truncateKaminoApy", () => {
  it("truncates Kamino's 21-decimal rates to six places without touching a float", () => {
    assert.equal(truncateKaminoApy("0.05925349346419595"), "0.059253");
    assert.equal(truncateKaminoApy("0.069159002836152534109"), "0.069159");
  });

  it("truncates rather than rounds, so a rate is never quoted above the provider's", () => {
    // Rounding would answer "0.059999"; the seventh place must simply be dropped.
    assert.equal(truncateKaminoApy("0.0599989999"), "0.059998");
  });

  it("floors negative rates AWAY from zero, so a loss is never understated", () => {
    // Cutting the tail moves a negative number UP. `-0.012345` would quote a
    // smaller loss than the vault reported, which is the same failure as
    // quoting a bigger gain.
    assert.equal(truncateKaminoApy("-0.0123456789"), "-0.012346");
    // Carry across every retained place.
    assert.equal(truncateKaminoApy("-0.9999999"), "-1");
    // A negative value that already fits is exact — nothing to floor.
    assert.equal(truncateKaminoApy("-0.012345"), "-0.012345");
    assert.equal(truncateKaminoApy("-0.0123450000"), "-0.012345");
  });

  it("reports a sub-precision rate as zero rather than an empty or signed zero", () => {
    assert.equal(truncateKaminoApy("0.0000000001"), "0");
    // Negative: `0` would be ABOVE the provider's value, so it floors to the
    // smallest loss six places can express instead.
    assert.equal(truncateKaminoApy("-0.000000000001"), "-0.000001");
    // Genuinely zero, written long — nothing was discarded, so nothing floors.
    assert.equal(truncateKaminoApy("-0.0000000000"), "0");
  });

  /**
   * The invariant itself, checked numerically rather than by example: whatever
   * this returns, a customer comparing vaults must never see a rate better than
   * the one the provider published. Floats are fine HERE — the assertion is
   * about ordering, and the value under test is still produced by string
   * surgery.
   */
  it("never returns a value above the provider's, on either side of zero", () => {
    for (const reported of [
      "0.05925349346419595",
      "0.0599989999",
      "0.0000000001",
      "0",
      "-0.0000000001",
      "-0.0123456789",
      "-0.9999999",
      "-1.0000005",
      "-12.3456789",
    ]) {
      const quoted = truncateKaminoApy(reported);
      assert.ok(quoted !== undefined, `expected ${reported} to parse`);
      assert.ok(
        Number(quoted) <= Number(reported),
        `${reported} was quoted as ${quoted}, which is above it`
      );
    }
  });

  it("passes integers and trims trailing zeros", () => {
    assert.equal(truncateKaminoApy("0"), "0");
    assert.equal(truncateKaminoApy("1"), "1");
    assert.equal(truncateKaminoApy("0.050000"), "0.05");
  });

  it("answers undefined for anything unparseable, so callers render no rate", () => {
    for (const value of [undefined, null, "", "  ", "abc", "1e-8", "NaN", "0.1.2"]) {
      assert.equal(truncateKaminoApy(value), undefined, `expected ${String(value)} to be dropped`);
    }
  });
});

describe("distillKaminoVault", () => {
  it("catalogues a funded stablecoin vault", () => {
    const result = distillKaminoVault(vault(), metrics());
    assert.equal(result.outcome, "catalogued");
    assert.partialDeepStrictEqual(result.outcome === "catalogued" ? result.snapshot : {}, {
      providerReference: "VaULt1111111111111111111111111111111111111",
      name: "Steakhouse USDC",
      sourceKind: "defi",
      underlyingSource: "klend",
      depositMints: [USDC_MAINNET],
      shareMint: "sHaRe111111111111111111111111111111111111",
      apyType: "variable",
      currentApy: "0.04",
      liquidityTerm: "instant",
      hostCluster: "mainnet-beta",
    });
  });

  it("carries TVL, holders and fees as risk metadata — and no curator", () => {
    const result = distillKaminoVault(vault(), metrics());
    assert.equal(result.outcome, "catalogued");
    // deepEqual, not partial: the ABSENCE of `curator` is the assertion. Every
    // key here is a figure Kamino itself reports.
    assert.deepEqual(result.outcome === "catalogued" ? result.snapshot.riskMetadata : undefined, {
      tvlUsd: 10_000_000,
      holders: 42,
      managementFeeBps: 25,
      performanceFeeBps: 0,
    });
  });

  it("never reports a redemption delay — a K-Vault withdrawal is atomic", () => {
    const result = distillKaminoVault(vault(), metrics());
    assert.equal(result.outcome, "catalogued");
    assert.equal(
      result.outcome === "catalogued" ? result.snapshot.redemptionDelayDays : "set",
      undefined
    );
  });

  /**
   * The trust boundary, pinned. K-Vault creation is permissionless
   * (`KaminoManager.createVaultIxs`) and the name is free text the creator
   * picks, so a name that reads like a claim must not BECOME one: not a curator
   * attribution, and not an RWA classification that moves the vault into the
   * `sourceKind=rwa` filter integrators use to find real-world backing.
   *
   * The names below are exactly what an impersonation attempt looks like — a
   * real curator house and every RWA term the deleted regex matched. Clearing
   * the TVL floor for one sync is a cost, not an authorization.
   */
  it("never derives a curator or an RWA classification from the vault name", () => {
    for (const name of [
      "Steakhouse High Yield USDG",
      "Gauntlet Frontier",
      "MEV Capital USDC",
      "RWA USDC",
      "Kamino Private Credit USDC",
      "Kamino Institutional Commodity Yield",
      "Honeycomb RWA",
      "US Treasury Yield",
    ]) {
      const result = distillKaminoVault(vault({ name }), metrics());
      assert.equal(result.outcome, "catalogued");
      const snapshot = result.outcome === "catalogued" ? result.snapshot : undefined;
      // Catalogued and rendered under its own name — but SDP asserts nothing
      // from that name beyond quoting it.
      assert.equal(snapshot?.name, name);
      assert.equal(snapshot?.sourceKind, "defi");
      assert.equal(snapshot?.riskMetadata?.curator, undefined);
    }
  });

  it("stamps mainnet-beta even for a devnet mint it somehow saw", () => {
    // Defensive: Kamino only ever returns mainnet mints, but hostCluster is a
    // fact about the PROVIDER's deployment, never inferred from the mint.
    const result = distillKaminoVault(vault({ tokenMint: USDC_DEVNET }), metrics());
    assert.equal(result.outcome, "catalogued");
    assert.equal(
      result.outcome === "catalogued" ? result.snapshot.hostCluster : undefined,
      "mainnet-beta"
    );
  });

  it("omits shareMint when the vault reports none", () => {
    const result = distillKaminoVault(vault({ sharesMint: null }), metrics());
    assert.equal(result.outcome, "catalogued");
    assert.equal(
      result.outcome === "catalogued" ? "shareMint" in result.snapshot : true,
      false,
      "shareMint must be omitted, not set to undefined"
    );
  });

  describe("drops", () => {
    const dropped = (v: KaminoVault, m: KaminoVaultMetrics | undefined) => {
      const result = distillKaminoVault(v, m);
      assert.equal(result.outcome, "dropped");
      return result.outcome === "dropped" ? result.reason : undefined;
    };

    it("drops a mint the well-known catalogue does not know", () => {
      assert.equal(
        dropped(vault({ tokenMint: "NotAMintNobodyVetted1111111111111111111" }), metrics()),
        "unknown_deposit_mint"
      );
    });

    it("drops a known token outside the Earn deposit set", () => {
      assert.equal(dropped(vault({ tokenMint: SOL_MINT }), metrics()), "not_a_deposit_token");
    });

    it("drops a blank name before it can reach a catalogue row", () => {
      assert.equal(dropped(vault({ name: "   " }), metrics()), "unnamed");
      assert.equal(dropped(vault({ name: null }), metrics()), "unnamed");
    });

    it("fails closed when no metrics row exists — TVL is the admission test", () => {
      assert.equal(dropped(vault(), undefined), "no_metrics");
    });

    it("drops a vault below the TVL floor", () => {
      assert.equal(
        dropped(vault(), metrics({ tokensAvailableUsd: "10", tokensInvestedUsd: "20" })),
        "below_tvl_floor"
      );
    });

    it("drops a vault whose TVL cannot be parsed at all", () => {
      assert.equal(
        dropped(vault(), metrics({ tokensAvailableUsd: null, tokensInvestedUsd: undefined })),
        "below_tvl_floor"
      );
    });

    it("admits a vault sitting exactly on the floor", () => {
      const result = distillKaminoVault(
        vault(),
        metrics({ tokensAvailableUsd: String(KAMINO_MIN_TVL_USD), tokensInvestedUsd: "0" })
      );
      assert.equal(result.outcome, "catalogued");
    });

    it("sums idle and invested balances toward the floor", () => {
      const half = String(KAMINO_MIN_TVL_USD / 2);
      const result = distillKaminoVault(
        vault(),
        metrics({ tokensAvailableUsd: half, tokensInvestedUsd: half })
      );
      assert.equal(result.outcome, "catalogued");
    });

    /**
     * Kamino serializes small balances in EXPONENT form — 28 of the 173 vaults
     * on the live shelf report `tokensAvailableUsd` as e.g. `"9.9984972e-7"`.
     * A plain-decimal-only parser reads those as "no value" and drops a real
     * balance out of the TVL, so `kaminoUsd` accepts the full numeric grammar
     * while the APY path keeps the strict regex its string-slicing needs.
     */
    it("counts exponent-form balances, which the live API really sends", () => {
      const result = distillKaminoVault(
        vault(),
        metrics({ tokensAvailableUsd: "9.9984972e-7", tokensInvestedUsd: "200000" })
      );

      assert.equal(result.outcome, "catalogued");
      // Strictly greater than the invested leg alone: the idle balance was
      // counted rather than silently discarded. Asserted as a property, not a
      // literal — the exact sum is not representable as a float.
      const tvlUsd = result.outcome === "catalogued" ? result.snapshot.riskMetadata?.tvlUsd : 0;
      assert.ok(typeof tvlUsd === "number" && tvlUsd > 200_000);
    });

    it("reports the token reason before the size reason, so the census reads by shelf", () => {
      assert.equal(
        dropped(vault({ tokenMint: SOL_MINT }), metrics({ tokensAvailableUsd: "0" })),
        "not_a_deposit_token"
      );
    });
  });
});

describe("KaminoEarnClient.listStrategies", () => {
  it("joins the vault list with bulk metrics and catalogues what clears the floor", async () => {
    const fetchMock = stubKaminoFetch(
      ...catalogue(
        [
          vault({ address: "big", name: "Steakhouse USDC" }),
          vault({ address: "small", name: "tst lght" }),
          vault({ address: "usdg", name: "Steakhouse High Yield USDG", tokenMint: USDG_MAINNET }),
        ],
        [
          metrics({ kvault: "big" }),
          metrics({ kvault: "small", tokensAvailableUsd: "3", tokensInvestedUsd: "0" }),
          metrics({ kvault: "usdg" }),
        ]
      )
    );

    const snapshots = await client.listStrategies(productionCtx);

    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.providerReference),
      ["big", "usdg"]
    );
    const [vaultsUrl, metricsUrl] = requestUrls(fetchMock);
    assert.match(vaultsUrl, /\/kvaults\/vaults$/);
    assert.match(metricsUrl, /\/kvaults\/vaults\/metrics\?limit=100$/);
  });

  it("sends no Authorization header — the data API is public", async () => {
    const fetchMock = stubKaminoFetch(...catalogue([vault()], [metrics()]));

    await client.listStrategies(productionCtx);

    const headers = new Headers(
      (fetchMock.mock.calls[0].arguments[1] as RequestInit | undefined)?.headers
    );
    assert.equal(headers.has("authorization"), false);
  });

  it("pages the metrics endpoint until the token clears", async () => {
    const fetchMock = stubKaminoFetch(
      { body: [vault({ address: "a" }), vault({ address: "b" })] },
      { body: { result: [metrics({ kvault: "a" })], paginationToken: "page-2" } },
      { body: { result: [metrics({ kvault: "b" })], paginationToken: null } }
    );

    const snapshots = await client.listStrategies(productionCtx);

    assert.deepEqual(snapshots.map((snapshot) => snapshot.providerReference).sort(), ["a", "b"]);
    assert.match(requestUrls(fetchMock)[2], /paginationToken=page-2/);
  });

  it("refuses a partial shelf when the server always echoes a token", async () => {
    const fetchMock = stubKaminoFetch(
      { body: [vault()] },
      { body: { result: [metrics()], paginationToken: "forever" } }
    );

    // Bounded AND loud: a short map would silently mass-delist — see
    // `_loadMetricsByVault`.
    await assert.rejects(client.listStrategies(productionCtx), /refusing a partial shelf/);

    // 1 vault-list call + the page cap. Without the cap this never returns.
    assert.equal(fetchMock.mock.calls.length, 1 + 20);
  });

  /**
   * This assertion is the INVERSE of the one it replaces.
   *
   * The old test pinned "sandbox gets the same mainnet catalogue as production",
   * which encoded a belief that turned out to be false: Kamino does run a devnet
   * kvault program, with 21 vaults on it (see providers/kamino/devnet.ts). The
   * consequence of the old behaviour was a sandbox shelf of permanently
   * un-fundable rows.
   *
   * Non-production must therefore never touch the mainnet REST API at all — not
   * "fetch it and filter", which would still put a mainnet row one bug away from
   * a sandbox database.
   */
  it("never reads the mainnet catalogue outside production", async () => {
    const fetchMock = stubKaminoFetch(...catalogue([vault()], [metrics()]));

    await assert.rejects(
      // No RPC URL in the sandbox context, so the devnet path fails closed —
      // which itself proves the mainnet REST path was not taken.
      client.listStrategies(sandboxCtx),
      /RPC URL/
    );
    assert.equal(
      fetchMock.mock.calls.length,
      0,
      "sandbox must not issue a single api.kamino.finance request"
    );
  });

  it("refuses a metrics page with no result array", async () => {
    // providerFetchJson does no schema validation, so a 200 carrying `{}` would
    // otherwise read as "this page held zero vaults" — indistinguishable from a
    // genuinely empty shelf, and the same silent-delisting hazard.
    stubKaminoFetch({ body: [vault()] }, { body: {} });

    await assert.rejects(client.listStrategies(productionCtx), /no result array/);
  });

  it("accepts a legitimately empty result array", async () => {
    // The control: an empty page is valid and must NOT be confused with the
    // malformed case above. Nothing is catalogued because nothing has metrics.
    stubKaminoFetch({ body: [vault()] }, { body: { result: [], paginationToken: null } });

    assert.deepEqual(await client.listStrategies(productionCtx), []);
  });

  it("keeps the whole pass failing when the provider errors", async () => {
    stubKaminoFetch({ status: 503, body: { message: "upstream down" } });

    await assert.rejects(client.listStrategies(productionCtx), /upstream down/);
  });
});

describe("KaminoEarnClient.listStrategyMetrics", () => {
  it("reports fresh figures without re-fetching the vault list", async () => {
    // One call, not two: nothing the vault registry carries (name, mints,
    // share mint) can change between hourly syncs, so the refresh must not pay
    // for the 348KB list on every five-minute tick.
    const fetchMock = stubKaminoFetch({
      body: {
        result: [metrics({ kvault: "vault-a", apy: "0.0512345678", numberOfHolders: 7 })],
        paginationToken: null,
      },
    });

    const result = await client.listStrategyMetrics(productionCtx);

    assert.equal(fetchMock.mock.calls.length, 1);
    assert.match(requestUrls(fetchMock)[0], /\/kvaults\/vaults\/metrics\?limit=100$/);
    assert.deepEqual(result, [
      {
        providerReference: "vault-a",
        currentApy: "0.051234",
        riskMetadata: { tvlUsd: 10_000_000, holders: 7 },
      },
    ]);
  });

  it("reports figures for vaults the catalogue refused, which the refresh no-ops on", async () => {
    // Filtering here would mean re-fetching the vault list to re-run the
    // admission gates. The refresh updates existing rows only, so an unknown
    // reference costs one no-op UPDATE.
    stubKaminoFetch({
      body: {
        result: [
          metrics({ kvault: "big" }),
          metrics({ kvault: "dust", tokensAvailableUsd: "1", tokensInvestedUsd: "0" }),
        ],
        paginationToken: null,
      },
    });

    const result = await client.listStrategyMetrics(productionCtx);

    assert.deepEqual(
      result.map((entry) => entry.providerReference),
      ["big", "dust"]
    );
  });

  it("omits the rate rather than inventing one when the provider reports none", async () => {
    stubKaminoFetch({
      body: { result: [metrics({ apy: null })], paginationToken: null },
    });

    const [entry] = await client.listStrategyMetrics(productionCtx);

    assert.equal(entry.currentApy, undefined);
  });

  it("carries no field that could change what a strategy IS", async () => {
    // The guard behind "a refresh cannot admit or redefine a vault": if this
    // shape ever grows a name, mint or liquidity term, the refresh pass stops
    // being safe to run unslotted and ungated.
    stubKaminoFetch({ body: { result: [metrics()], paginationToken: null } });

    const [entry] = await client.listStrategyMetrics(productionCtx);

    assert.deepEqual(Object.keys(entry).sort(), [
      "currentApy",
      "providerReference",
      "riskMetadata",
    ]);
  });

  /**
   * Inverted alongside `listStrategies`. The metrics endpoint belongs to the
   * MAINNET API and 404s for a devnet vault pubkey, so outside production the
   * only honest answer is none: the map would be keyed by mainnet references
   * that `updateStrategyMetrics` then fails to match against a devnet
   * catalogue, no-opping on every five-minute pass while spending two requests
   * to do it. A sandbox row renders "—" rather than a fabricated rate.
   */
  it("reports no figures outside production, and issues no request", async () => {
    const fetchMock = stubKaminoFetch({
      body: { result: [metrics()], paginationToken: null },
    });

    assert.deepEqual(await client.listStrategyMetrics(sandboxCtx), []);
    assert.equal(
      fetchMock.mock.calls.length,
      0,
      "sandbox must not issue a single api.kamino.finance request"
    );
  });
});

describe("KaminoEarnClient contract surface", () => {
  it("declares the stablecoin envelope and `defi` alone", () => {
    // `rwa` is deliberately absent: nothing this client emits can establish it,
    // because the only signal Kamino offers is the permissionless vault name.
    assert.deepEqual(client.declaredSupport.sourceKinds, ["defi"]);
    assert.deepEqual(client.declaredSupport.depositTokens, ["USDC", "USDG", "USDT", "PYUSD"]);
  });

  it("keeps the catalogue client outside the portfolio-wallet capability", () => {
    // Guards the shape the API's capability detection relies on to answer 501.
    for (const method of [
      "createPortfolioWallet",
      "getPortfolioWallet",
      "previewPortfolioWithdrawal",
      "createPortfolioWithdrawal",
    ]) {
      assert.equal(
        method in client,
        false,
        `${method} must not exist: Kamino moves no money through SDP`
      );
    }
  });
});
