import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { wellKnownMint } from "@sdp/types";
import type { EarnRuntimeContext } from "../../types";
import {
  deriveKaminoCurator,
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

  it("keeps negative rates, which real vaults report", () => {
    assert.equal(truncateKaminoApy("-0.0123456789"), "-0.012345");
  });

  it("reports a sub-precision rate as zero rather than an empty or signed zero", () => {
    assert.equal(truncateKaminoApy("0.0000000001"), "0");
    assert.equal(truncateKaminoApy("-0.0000000001"), "0");
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

describe("deriveKaminoCurator", () => {
  it("matches a curator house named in the vault name", () => {
    assert.equal(deriveKaminoCurator("Steakhouse High Yield USDG"), "steakhouse");
    assert.equal(deriveKaminoCurator("Allez USDT"), "allez");
    assert.equal(deriveKaminoCurator("Gauntlet Frontier"), "gauntlet");
    assert.equal(deriveKaminoCurator("MEV Capital USDC"), "mev_capital");
  });

  it("prefers the longer house name so a shorter entry cannot shadow it", () => {
    assert.equal(deriveKaminoCurator("Neutral Trade USDC Max Yield"), "neutral_trade");
    assert.equal(deriveKaminoCurator("NeutralTrade USDC Max Yield"), "neutral_trade");
  });

  it("attributes an unrecognized vault to Kamino, which curates its own", () => {
    assert.equal(deriveKaminoCurator("Kamino Private Credit USDC"), "kamino");
    assert.equal(deriveKaminoCurator("Some House Nobody Listed"), "kamino");
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

  it("carries curator, TVL, holders and fees as risk metadata", () => {
    const result = distillKaminoVault(vault(), metrics());
    assert.equal(result.outcome, "catalogued");
    assert.deepEqual(result.outcome === "catalogued" ? result.snapshot.riskMetadata : undefined, {
      curator: "steakhouse",
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

  it("classifies the RWA vaults by name", () => {
    for (const name of [
      "RWA USDC",
      "Kamino Private Credit USDC",
      "Kamino Institutional Commodity Yield",
      "Honeycomb RWA",
    ]) {
      const result = distillKaminoVault(vault({ name }), metrics());
      assert.equal(result.outcome, "catalogued");
      assert.equal(result.outcome === "catalogued" ? result.snapshot.sourceKind : undefined, "rwa");
    }
  });

  it("does not read 'rwa' out of the middle of a word", () => {
    const result = distillKaminoVault(vault({ name: "Drwaggon USDC" }), metrics());
    assert.equal(result.outcome, "catalogued");
    assert.equal(result.outcome === "catalogued" ? result.snapshot.sourceKind : undefined, "defi");
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

    // Bounded (the cap stops the spin) AND loud. Returning the pages it did
    // read would be worse than failing: a vault with no metrics row is dropped
    // as `no_metrics`, and the catalogue sync DELETES rows a provider no longer
    // lists — so a short map delists every vault whose page went unread. The
    // throw makes the sync skip the pass instead.
    await assert.rejects(client.listStrategies(productionCtx), /refusing a partial shelf/);

    // 1 vault-list call + the page cap. Without the cap this never returns.
    assert.equal(fetchMock.mock.calls.length, 1 + 20);
  });

  it("returns the SAME mainnet catalogue in sandbox as in production", async () => {
    stubKaminoFetch(...catalogue([vault()], [metrics()]));
    const production = await client.listStrategies(productionCtx);

    mock.restoreAll();
    stubKaminoFetch(...catalogue([vault()], [metrics()]));
    const sandbox = await client.listStrategies(sandboxCtx);

    assert.deepEqual(sandbox, production);
    // The whole point: a sandbox row states mainnet, so nothing downstream can
    // mistake it for something devnet money can fund.
    assert.equal(sandbox[0].hostCluster, "mainnet-beta");
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

  it("reports the same figures in both environments", async () => {
    stubKaminoFetch({ body: { result: [metrics()], paginationToken: null } });
    const production = await client.listStrategyMetrics(productionCtx);

    mock.restoreAll();
    stubKaminoFetch({ body: { result: [metrics()], paginationToken: null } });
    const sandbox = await client.listStrategyMetrics(sandboxCtx);

    assert.deepEqual(sandbox, production);
  });
});

describe("KaminoEarnClient contract surface", () => {
  it("declares the stablecoin envelope and both source kinds", () => {
    assert.deepEqual(client.declaredSupport.sourceKinds, ["defi", "rwa"]);
    assert.deepEqual(client.declaredSupport.depositTokens, ["USDC", "USDG", "USDT"]);
  });

  it("implements no portfolio-wallet capability — Kamino is catalogue-only", () => {
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
