import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { wellKnownMint } from "@sdp/types";
import { SdpEarnError, type SdpEarnErrorCode } from "../../errors";
import type { EarnRuntimeContext } from "../../types";
import { GroundEarnClient } from "./client";

/**
 * Canonical no-network harness (see src/fetch.test.ts): `globalThis.fetch` is
 * stubbed per test and restored in `afterEach` — no test may ever reach the
 * real Ground API.
 */

const client = new GroundEarnClient();

const sandboxCtx: EarnRuntimeContext = {
  env: { GROUND_SANDBOX_API_KEY: "sandbox-key" },
  environment: "sandbox",
};
const productionCtx: EarnRuntimeContext = {
  env: { GROUND_API_KEY: "production-key" },
  environment: "production",
};

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status });

/** Queue JSON replies; extra calls replay the last reply. */
function stubGroundFetch(...replies: Array<{ status?: number; body: unknown }>) {
  let index = 0;
  return mock.method(globalThis, "fetch", async () => {
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return jsonResponse(reply.status ?? 200, reply.body);
  });
}

type FetchMock = ReturnType<typeof stubGroundFetch>;

const requestUrl = (fetchMock: FetchMock, call = 0): string =>
  String(fetchMock.mock.calls[call].arguments[0]);

const requestInit = (fetchMock: FetchMock, call = 0) => fetchMock.mock.calls[call].arguments[1];

const requestBody = (fetchMock: FetchMock, call = 0): Record<string, unknown> =>
  JSON.parse(String(requestInit(fetchMock, call)?.body)) as Record<string, unknown>;

const earnError =
  (code: SdpEarnErrorCode, message?: RegExp) =>
  (error: unknown): boolean =>
    error instanceof SdpEarnError &&
    error.code === code &&
    (message === undefined || message.test(error.message));

const page = (data: unknown[], nextCursor: string | null = null) => ({ data, nextCursor });

const yieldSource = (overrides: Record<string, unknown> = {}) => ({
  id: "morpho-gauntlet-usdc",
  name: "Morpho Gauntlet USDC",
  description: null,
  mode: "active",
  chain: "ethereum",
  apyBps: 356,
  navUpdateMode: "continuous",
  tvlUsd: 512_400_000,
  utilizationPct: 82.5,
  addresses: [],
  allocations: [{ label: "Morpho lending", type: "lending", valueUsd: null, pct: 100 }],
  links: [],
  protocol: "Morpho",
  depositToken: "usdc",
  maxAllocationUsd: null,
  processingPolicies: {
    deposit: { processingTimeBasis: "elapsed_seconds", typicalMinUnits: 0, typicalMaxUnits: 0 },
    redeem: { processingTimeBasis: "elapsed_seconds", typicalMinUnits: 0, typicalMaxUnits: 0 },
  },
  ...overrides,
});

const groundWallet = (overrides: Record<string, unknown> = {}) => ({
  id: "wal_1",
  label: "SDP Earn",
  createdAt: "2026-08-01T00:00:00Z",
  status: "idle",
  failureReason: null,
  depositAddresses: {
    ethereum: "0xEthereumAddress",
    solana: "So1anaMainnetDepositAddr",
    solana_devnet: "So1anaDevnetDepositAddr",
  },
  balance: {
    totalUsd: "100.000000",
    withdrawableUsd: "90.000000",
    reservedUsd: "10.000000",
    earnedUsd: "1.250000",
  },
  positions: [
    {
      id: "pos_1",
      kind: "yield_source",
      label: "Morpho Gauntlet USDC",
      valueUsd: "80.000000",
      pct: 80,
      yieldSourceId: "morpho-gauntlet-usdc",
      token: "usdc",
    },
    { id: "pos_2", kind: "cash", label: "Cash", valueUsd: "20.000000", pct: 20 },
  ],
  strategyAllocations: {
    usdc: [
      { yieldSourceId: "morpho-gauntlet-usdc", targetWeightBps: 8000 },
      { yieldSourceId: "cash", targetWeightBps: 2000 },
    ],
  },
  ...overrides,
});

const groundWithdrawal = (overrides: Record<string, unknown> = {}) => ({
  id: "wd_1",
  amountRequestedUsd: "50.000000",
  amountPaidUsd: null,
  feeUsd: "0.000000",
  destinationChain: "solana_devnet",
  destinationAddress: "DestAddr1111111111111111111111111111111111",
  destinationToken: "usdc",
  status: "processing",
  failureReason: null,
  createdAt: "2026-08-03T00:00:00Z",
  completedAt: null,
  ...overrides,
});

afterEach(() => {
  mock.restoreAll();
});

describe("GroundEarnClient.listStrategies", () => {
  it("maps an active yield source onto the catalogue snapshot", async () => {
    const fetchMock = stubGroundFetch({ body: page([yieldSource()]) });

    const strategies = await client.listStrategies(sandboxCtx);

    assert.equal(requestUrl(fetchMock), "https://sandbox.groundtech.co/v2/wallets/yield-sources");
    assert.deepEqual(requestInit(fetchMock)?.headers, {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: "Bearer sandbox-key",
    });
    assert.deepEqual(strategies, [
      {
        providerReference: "morpho-gauntlet-usdc",
        name: "Morpho Gauntlet USDC",
        sourceKind: "defi",
        underlyingSource: "morpho",
        depositMints: [wellKnownMint("USDC", "devnet")],
        apyType: "variable",
        currentApy: "0.0356",
        liquidityTerm: "instant",
        riskMetadata: { curator: "gauntlet", tvlUsd: 512_400_000, utilizationPct: 82.5 },
      },
    ]);
  });

  it("uses the production host, key, and mainnet mints in production", async () => {
    const fetchMock = stubGroundFetch({
      body: page([yieldSource(), yieldSource({ id: "tether-reserve", depositToken: "usdt" })]),
    });

    const strategies = await client.listStrategies(productionCtx);

    assert.equal(
      requestUrl(fetchMock),
      "https://production.groundtech.co/v2/wallets/yield-sources"
    );
    assert.match(
      new Headers(requestInit(fetchMock)?.headers).get("Authorization") ?? "",
      /^Bearer production-key$/
    );
    assert.deepEqual(
      strategies.map((s) => s.depositMints),
      [[wellKnownMint("USDC", "mainnet-beta")], [wellKnownMint("USDT", "mainnet-beta")]]
    );
  });

  it("converts apyBps to a decimal string without float drift", async () => {
    stubGroundFetch({
      body: page([
        yieldSource({ id: "a", apyBps: 5 }),
        yieldSource({ id: "b", apyBps: 620 }),
        yieldSource({ id: "c", apyBps: 10_000 }),
        yieldSource({ id: "d", apyBps: 12_345 }),
        yieldSource({ id: "e", apyBps: null }),
      ]),
    });

    const strategies = await client.listStrategies(sandboxCtx);

    assert.deepEqual(
      strategies.map((s) => s.currentApy),
      ["0.0005", "0.062", "1", "1.2345", undefined]
    );
  });

  it("maps the redeem policy onto liquidity terms, rounding delays up to days", async () => {
    stubGroundFetch({
      body: page([
        yieldSource({ id: "instant" }),
        yieldSource({
          id: "delayed-seconds",
          processingPolicies: {
            redeem: {
              processingTimeBasis: "elapsed_seconds",
              typicalMinUnits: 3600,
              typicalMaxUnits: 172_801,
            },
          },
        }),
        yieldSource({
          id: "delayed-banking-days",
          processingPolicies: {
            redeem: { processingTimeBasis: "banking_days", typicalMinUnits: 1, typicalMaxUnits: 3 },
          },
        }),
        yieldSource({ id: "no-policy", processingPolicies: null }),
      ]),
    });

    const strategies = await client.listStrategies(sandboxCtx);

    assert.deepEqual(
      strategies.map(({ providerReference, liquidityTerm, redemptionDelayDays }) => ({
        providerReference,
        liquidityTerm,
        redemptionDelayDays,
      })),
      [
        { providerReference: "instant", liquidityTerm: "instant", redemptionDelayDays: undefined },
        {
          providerReference: "delayed-seconds",
          liquidityTerm: "delayed",
          redemptionDelayDays: 3,
        },
        {
          providerReference: "delayed-banking-days",
          liquidityTerm: "delayed",
          redemptionDelayDays: 3,
        },
        {
          providerReference: "no-policy",
          liquidityTerm: "instant",
          redemptionDelayDays: undefined,
        },
      ]
    );
  });

  it("skips every non-active mode so no exit-frozen source becomes depositable", async () => {
    stubGroundFetch({
      body: page([
        yieldSource({ id: "buying-only", mode: "buy_only" }),
        yieldSource({ id: "selling-only", mode: "sell_only" }),
        yieldSource({ id: "frozen", mode: "emergency_freeze" }),
        yieldSource({ id: "live" }),
      ]),
    });

    const strategies = await client.listStrategies(sandboxCtx);

    assert.deepEqual(
      strategies.map((s) => s.providerReference),
      ["live"]
    );
  });

  it("skips deposit tokens without a mint on the environment's cluster", async () => {
    stubGroundFetch({
      body: page([
        yieldSource({ id: "usdc-source" }),
        // USDT has no devnet mint, so this source cannot be funded in sandbox.
        yieldSource({ id: "usdt-source", depositToken: "usdt" }),
      ]),
    });

    const strategies = await client.listStrategies(sandboxCtx);

    assert.deepEqual(
      strategies.map((s) => s.providerReference),
      ["usdc-source"]
    );
  });

  it("derives curators from known ids, the morpho naming convention, then protocol", async () => {
    stubGroundFetch({
      body: page([
        yieldSource({ id: "prime-usdc", name: "Steakhouse Prime USDC", protocol: "Morpho" }),
        yieldSource({ id: "morpho-clearstar-usdc", name: "Clearstar USDC", protocol: "Morpho" }),
        yieldSource({ id: "syrup-usdc", name: "Syrup USDC", protocol: "Maple" }),
        yieldSource({ id: "bare-usdc", name: "Bare USDC", protocol: null }),
      ]),
    });

    const strategies = await client.listStrategies(sandboxCtx);

    assert.deepEqual(
      strategies.map((s) => s.riskMetadata?.curator),
      ["steakhouse", "clearstar", "maple", undefined]
    );
  });

  it("classifies the dominant allocation side as the source kind", async () => {
    stubGroundFetch({
      body: page([
        yieldSource({
          id: "mostly-treasuries",
          allocations: [
            { label: "T-bills", type: "treasury", pct: 70 },
            { label: "CLO sleeve", type: "clo", pct: 10 },
            { label: "Reserve", type: "lending", pct: 20 },
          ],
        }),
        yieldSource({
          id: "mostly-lending",
          allocations: [
            { label: "Morpho", type: "lending", pct: 90 },
            { label: "Bond sleeve", type: "bond", pct: 10 },
          ],
        }),
        yieldSource({ id: "no-allocations", allocations: [] }),
      ]),
    });

    const strategies = await client.listStrategies(sandboxCtx);

    assert.deepEqual(
      strategies.map((s) => s.sourceKind),
      ["rwa", "defi", "defi"]
    );
  });

  it("follows nextCursor across pages", async () => {
    const fetchMock = stubGroundFetch(
      { body: page([yieldSource({ id: "page-one" })], "cursor-2") },
      { body: page([yieldSource({ id: "page-two" })]) }
    );

    const strategies = await client.listStrategies(sandboxCtx);

    assert.equal(fetchMock.mock.callCount(), 2);
    assert.equal(
      requestUrl(fetchMock, 1),
      "https://sandbox.groundtech.co/v2/wallets/yield-sources?cursor=cursor-2"
    );
    assert.deepEqual(
      strategies.map((s) => s.providerReference),
      ["page-one", "page-two"]
    );
  });

  it("fails closed with PROVIDER_NOT_CONFIGURED before any request when the key is missing", async () => {
    const fetchMock = stubGroundFetch({ body: page([]) });

    await assert.rejects(
      client.listStrategies({ env: {}, environment: "sandbox" }),
      earnError("PROVIDER_NOT_CONFIGURED", /GROUND_SANDBOX_API_KEY/)
    );
    await assert.rejects(
      client.listStrategies({ env: {}, environment: "production" }),
      earnError("PROVIDER_NOT_CONFIGURED", /GROUND_API_KEY/)
    );
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it("classifies provider failures into the SdpEarnError taxonomy", async () => {
    stubGroundFetch({ status: 401, body: { error: "unauthorized", code: "unauthorized" } });
    await assert.rejects(client.listStrategies(sandboxCtx), earnError("BAD_REQUEST"));

    mock.restoreAll();
    stubGroundFetch({ status: 429, body: { error: "rate limited" } });
    await assert.rejects(client.listStrategies(sandboxCtx), earnError("RATE_LIMITED"));

    mock.restoreAll();
    stubGroundFetch({ status: 503, body: { error: "down" } });
    await assert.rejects(client.listStrategies(sandboxCtx), earnError("PROVIDER_UNAVAILABLE"));
  });
});

describe("GroundEarnClient.createPortfolioWallet", () => {
  it("posts the labelled strategy and passes the caller's requestId through verbatim", async () => {
    const fetchMock = stubGroundFetch({ body: groundWallet({ status: "creating" }) });

    const result = await client.createPortfolioWallet(sandboxCtx, {
      label: "SDP Earn — org_1",
      allocations: { usdc: [{ yieldSourceId: "morpho-gauntlet-usdc", pct: 100 }] },
      requestId: "11111111-1111-4111-8111-111111111111",
    });

    assert.equal(requestUrl(fetchMock), "https://sandbox.groundtech.co/v2/wallets");
    assert.equal(requestInit(fetchMock)?.method, "POST");
    assert.deepEqual(requestBody(fetchMock), {
      requestId: "11111111-1111-4111-8111-111111111111",
      label: "SDP Earn — org_1",
      strategy: { allocations: { usdc: [{ yieldSourceId: "morpho-gauntlet-usdc", pct: 100 }] } },
    });
    assert.deepEqual(result, { providerWalletRef: "wal_1", status: "creating" });
  });

  it("generates a UUIDv4 requestId when the caller omits one", async () => {
    const fetchMock = stubGroundFetch({ body: groundWallet({ status: "creating" }) });

    await client.createPortfolioWallet(sandboxCtx, { label: "SDP Earn", allocations: {} });

    assert.match(String(requestBody(fetchMock).requestId), UUID_V4_PATTERN);
  });
});

describe("GroundEarnClient.getPortfolioWallet", () => {
  it("normalizes the wallet and exposes only the environment's Solana deposit address", async () => {
    const fetchMock = stubGroundFetch({ body: groundWallet() });

    const snapshot = await client.getPortfolioWallet(sandboxCtx, { providerWalletRef: "wal_1" });

    assert.equal(requestUrl(fetchMock), "https://sandbox.groundtech.co/v2/wallets/wal_1");
    assert.deepEqual(snapshot, {
      providerWalletRef: "wal_1",
      status: "ready",
      providerStatus: "idle",
      solanaDepositAddress: "So1anaDevnetDepositAddr",
      balance: {
        totalUsd: "100.000000",
        withdrawableUsd: "90.000000",
        reservedUsd: "10.000000",
        earnedUsd: "1.250000",
      },
      positions: [
        {
          kind: "yield_source",
          label: "Morpho Gauntlet USDC",
          valueUsd: "80.000000",
          pct: 80,
          yieldSourceId: "morpho-gauntlet-usdc",
          token: "usdc",
        },
        {
          kind: "cash",
          label: "Cash",
          valueUsd: "20.000000",
          pct: 20,
          yieldSourceId: undefined,
          token: undefined,
        },
      ],
      allocations: {
        usdc: [
          { yieldSourceId: "morpho-gauntlet-usdc", weightBps: 8000 },
          { yieldSourceId: "cash", weightBps: 2000 },
        ],
      },
    });
  });

  it("picks the mainnet solana address in production", async () => {
    stubGroundFetch({ body: groundWallet() });

    const snapshot = await client.getPortfolioWallet(productionCtx, { providerWalletRef: "wal_1" });

    assert.equal(snapshot.solanaDepositAddress, "So1anaMainnetDepositAddr");
  });

  it("treats in-flight and unknown provider statuses as busy, keeping the raw status", async () => {
    stubGroundFetch(
      { body: groundWallet({ status: "withdrawal_and_rebalance_active" }) },
      { body: groundWallet({ status: "some_future_state" }) },
      { body: groundWallet({ status: "failed" }) }
    );

    const inFlight = await client.getPortfolioWallet(sandboxCtx, { providerWalletRef: "wal_1" });
    const unknown = await client.getPortfolioWallet(sandboxCtx, { providerWalletRef: "wal_1" });
    const failed = await client.getPortfolioWallet(sandboxCtx, { providerWalletRef: "wal_1" });

    assert.deepEqual(
      [inFlight, unknown, failed].map(({ status, providerStatus }) => ({
        status,
        providerStatus,
      })),
      [
        { status: "busy", providerStatus: "withdrawal_and_rebalance_active" },
        { status: "busy", providerStatus: "some_future_state" },
        { status: "failed", providerStatus: "failed" },
      ]
    );
  });

  it("normalizes unmapped position kinds to unknown instead of dropping funds", async () => {
    stubGroundFetch({
      body: groundWallet({
        depositAddresses: {},
        positions: [
          { id: "p1", kind: "external_payout", label: "Payout leg", valueUsd: "5.000000" },
          { id: "p2", kind: "quantum_sleeve", label: "New kind", valueUsd: "1.000000" },
        ],
      }),
    });

    const snapshot = await client.getPortfolioWallet(sandboxCtx, { providerWalletRef: "wal_1" });

    assert.equal(snapshot.solanaDepositAddress, undefined);
    assert.deepEqual(
      snapshot.positions.map((p) => p.kind),
      ["external_payout", "unknown"]
    );
  });
});

describe("GroundEarnClient.getPortfolioYield", () => {
  const groundYield = (positions: unknown[]) => ({
    walletId: "wal_1",
    earnedUsd: "12.500000",
    annualizedUsd: "40.000000",
    positions,
  });

  it("converts apyBps to decimals and blends by target allocation when nothing is deployed", async () => {
    // The real sandbox shape for a funded-but-unrebalanced program: weights are
    // set, deployed value is still zero. Reproduces Ground's own dashboard
    // figure of 3.71% for a 50/50 split of 1.54% and 5.87%.
    const fetchMock = stubGroundFetch({
      body: groundYield([
        {
          yieldSourceId: "kamino-superstate-usdc",
          name: "A",
          apyBps: 154,
          pct: 50,
          deployedValueUsd: "0.000000",
        },
        {
          yieldSourceId: "kamino-rockawayx-rwa-usdc",
          name: "B",
          apyBps: 587,
          pct: 50,
          deployedValueUsd: "0.000000",
        },
      ]),
    });

    const result = await client.getPortfolioYield(sandboxCtx, { providerWalletRef: "wal_1" });

    assert.equal(requestUrl(fetchMock), "https://sandbox.groundtech.co/v2/wallets/wal_1/yield");
    assert.equal(result.earnedUsd, "12.500000");
    assert.equal(result.annualizedUsd, "40.000000");
    // (1.54% + 5.87%) / 2 = 3.705%, which Ground's dashboard renders as 3.71%.
    assert.equal(result.currentApy, "0.037050");
    assert.deepEqual(
      result.positions.map((position) => position.apy),
      ["0.0154", "0.0587"]
    );
  });

  it("weights by deployed value once capital is actually deployed", async () => {
    stubGroundFetch({
      body: groundYield([
        { yieldSourceId: "a", name: "A", apyBps: 200, pct: 50, deployedValueUsd: "900.000000" },
        { yieldSourceId: "b", name: "B", apyBps: 1000, pct: 50, deployedValueUsd: "100.000000" },
      ]),
    });

    const result = await client.getPortfolioYield(sandboxCtx, { providerWalletRef: "wal_1" });

    // Deployed weighting (0.9*2% + 0.1*10% = 2.8%) — not the 6% a naive
    // target-weight blend would report.
    assert.equal(Number(result.currentApy).toFixed(4), "0.0280");
  });

  it("omits the rate for an all-cash program rather than reporting 0%", async () => {
    stubGroundFetch({ body: groundYield([]) });

    const result = await client.getPortfolioYield(sandboxCtx, { providerWalletRef: "wal_1" });

    assert.equal(result.currentApy, undefined);
    assert.deepEqual(result.positions, []);
  });

  it("classifies provider failures through the shared taxonomy", async () => {
    stubGroundFetch({ status: 503, body: { message: "yield unavailable" } });

    await assert.rejects(
      client.getPortfolioYield(sandboxCtx, { providerWalletRef: "wal_1" }),
      earnError("PROVIDER_UNAVAILABLE")
    );
  });
});

describe("GroundEarnClient.updatePortfolioStrategy", () => {
  it("PATCHes the strategy and returns the provider-confirmed bps weights", async () => {
    const fetchMock = stubGroundFetch({
      body: {
        strategyAllocations: {
          usdc: [{ yieldSourceId: "syrup-usdc", targetWeightBps: 10_000 }],
        },
      },
    });

    const result = await client.updatePortfolioStrategy(sandboxCtx, {
      providerWalletRef: "wal_1",
      allocations: { usdc: [{ yieldSourceId: "syrup-usdc", pct: 100 }] },
      requestId: "22222222-2222-4222-8222-222222222222",
    });

    assert.equal(requestUrl(fetchMock), "https://sandbox.groundtech.co/v2/wallets/wal_1/strategy");
    assert.equal(requestInit(fetchMock)?.method, "PATCH");
    assert.deepEqual(requestBody(fetchMock), {
      requestId: "22222222-2222-4222-8222-222222222222",
      allocations: { usdc: [{ yieldSourceId: "syrup-usdc", pct: 100 }] },
    });
    assert.deepEqual(result, {
      allocations: { usdc: [{ yieldSourceId: "syrup-usdc", weightBps: 10_000 }] },
    });
  });

  it("generates a UUIDv4 requestId when the caller omits one", async () => {
    const fetchMock = stubGroundFetch({ body: { strategyAllocations: {} } });

    await client.updatePortfolioStrategy(sandboxCtx, {
      providerWalletRef: "wal_1",
      allocations: {},
    });

    assert.match(String(requestBody(fetchMock).requestId), UUID_V4_PATTERN);
  });
});

describe("GroundEarnClient.listPortfolioDeposits", () => {
  it("maps the deposit page and passes the cursor through", async () => {
    const fetchMock = stubGroundFetch({
      body: page(
        [
          {
            id: "dep_1",
            amount: "100.500000",
            token: "usdc",
            chain: "solana_devnet",
            fromAddress: "FromAddr111111111111111111111111111111111",
            txHash: "5igSig111",
            status: "completed",
            createdAt: "2026-08-02T12:00:00Z",
            completedAt: "2026-08-02T12:05:00Z",
          },
          {
            id: "dep_2",
            amount: "25.000000",
            token: "usdt",
            chain: "solana_devnet",
            fromAddress: null,
            txHash: null,
            status: null,
            createdAt: "2026-08-03T09:00:00Z",
            completedAt: null,
          },
        ],
        "cursor-next"
      ),
    });

    const result = await client.listPortfolioDeposits(sandboxCtx, {
      providerWalletRef: "wal_1",
      cursor: "cursor-prev",
    });

    assert.equal(
      requestUrl(fetchMock),
      "https://sandbox.groundtech.co/v2/wallets/wal_1/deposits?cursor=cursor-prev"
    );
    assert.deepEqual(result, {
      deposits: [
        {
          id: "dep_1",
          amountUsd: "100.500000",
          token: "usdc",
          status: "completed",
          fromAddress: "FromAddr111111111111111111111111111111111",
          transactionSignature: "5igSig111",
          createdAt: "2026-08-02T12:00:00Z",
          completedAt: "2026-08-02T12:05:00Z",
        },
        {
          id: "dep_2",
          amountUsd: "25.000000",
          token: "usdt",
          // A null provider status is a deposit still being tracked.
          status: "processing",
          fromAddress: undefined,
          transactionSignature: undefined,
          createdAt: "2026-08-03T09:00:00Z",
          completedAt: undefined,
        },
      ],
      nextCursor: "cursor-next",
    });
  });

  it("omits the cursor param on the first page", async () => {
    const fetchMock = stubGroundFetch({ body: page([]) });

    await client.listPortfolioDeposits(sandboxCtx, { providerWalletRef: "wal_1" });

    assert.equal(requestUrl(fetchMock), "https://sandbox.groundtech.co/v2/wallets/wal_1/deposits");
  });
});

describe("GroundEarnClient.previewPortfolioWithdrawal", () => {
  it("previews on the environment's Solana rail with a numeric USD amount", async () => {
    const fetchMock = stubGroundFetch({
      body: {
        amountRequestedUsd: "50.000000",
        feeUsd: "0.100000",
        withdrawableUsd: "1000.000000",
        totalUsdAfterWithdrawal: "949.900000",
        processingEstimate: {
          basis: "elapsed_seconds",
          typicalMinDuration: "PT21M",
          typicalMaxDuration: "PT42M",
        },
      },
    });

    const preview = await client.previewPortfolioWithdrawal(sandboxCtx, {
      providerWalletRef: "wal_1",
      amountUsd: "50",
      token: "usdc",
    });

    assert.equal(
      requestUrl(fetchMock),
      "https://sandbox.groundtech.co/v2/wallets/wal_1/withdrawal-preview"
    );
    assert.deepEqual(requestBody(fetchMock), {
      destinationChain: "solana_devnet",
      token: "usdc",
      amountUsd: 50,
    });
    assert.deepEqual(preview, {
      amountRequestedUsd: "50.000000",
      feeUsd: "0.100000",
      withdrawableUsd: "1000.000000",
      totalUsdAfterWithdrawal: "949.900000",
      processingEstimate: {
        basis: "elapsed_seconds",
        typicalMinDuration: "PT21M",
        typicalMaxDuration: "PT42M",
      },
    });
  });

  it("rejects malformed USD amounts before any request", async () => {
    const fetchMock = stubGroundFetch({ body: {} });

    for (const amountUsd of ["", "-5", "1e3", "12.", "abc"]) {
      await assert.rejects(
        client.previewPortfolioWithdrawal(sandboxCtx, {
          providerWalletRef: "wal_1",
          amountUsd,
          token: "usdc",
        }),
        earnError("BAD_REQUEST", /Invalid USD amount/)
      );
    }
    assert.equal(fetchMock.mock.callCount(), 0);
  });
});

describe("GroundEarnClient.createPortfolioWithdrawal", () => {
  it("sends the caller-owned requestId verbatim to the environment's Solana rail", async () => {
    const fetchMock = stubGroundFetch({ body: groundWithdrawal() });

    const withdrawal = await client.createPortfolioWithdrawal(sandboxCtx, {
      providerWalletRef: "wal_1",
      requestId: "33333333-3333-4333-8333-333333333333",
      amountUsd: "50.25",
      token: "usdc",
      destinationAddress: "DestAddr1111111111111111111111111111111111",
    });

    assert.equal(
      requestUrl(fetchMock),
      "https://sandbox.groundtech.co/v2/wallets/wal_1/withdrawals"
    );
    assert.deepEqual(requestBody(fetchMock), {
      requestId: "33333333-3333-4333-8333-333333333333",
      destinationChain: "solana_devnet",
      token: "usdc",
      amountUsd: 50.25,
      destinationAddress: "DestAddr1111111111111111111111111111111111",
    });
    assert.deepEqual(withdrawal, {
      withdrawalRef: "wd_1",
      status: "processing",
      amountRequestedUsd: "50.000000",
      amountPaidUsd: undefined,
      feeUsd: "0.000000",
      token: "usdc",
      destinationAddress: "DestAddr1111111111111111111111111111111111",
      failureReason: undefined,
      createdAt: "2026-08-03T00:00:00Z",
      completedAt: undefined,
    });
  });

  it("surfaces an idempotency payload mismatch as CONFLICT", async () => {
    stubGroundFetch({
      status: 409,
      body: {
        error: "requestId was already used with a different payload",
        code: "request_id_conflict",
      },
    });

    await assert.rejects(
      client.createPortfolioWithdrawal(sandboxCtx, {
        providerWalletRef: "wal_1",
        requestId: "33333333-3333-4333-8333-333333333333",
        amountUsd: "50",
        token: "usdc",
        destinationAddress: "DestAddr1111111111111111111111111111111111",
      }),
      earnError("CONFLICT")
    );
  });
});

describe("GroundEarnClient.getPortfolioWithdrawal", () => {
  it("fetches one withdrawal and maps terminal fields", async () => {
    const fetchMock = stubGroundFetch({
      body: groundWithdrawal({
        status: "completed",
        amountPaidUsd: "49.900000",
        completedAt: "2026-08-03T00:30:00Z",
      }),
    });

    const withdrawal = await client.getPortfolioWithdrawal(sandboxCtx, {
      providerWalletRef: "wal_1",
      withdrawalRef: "wd_1",
    });

    assert.equal(
      requestUrl(fetchMock),
      "https://sandbox.groundtech.co/v2/wallets/wal_1/withdrawals/wd_1"
    );
    assert.equal(withdrawal.status, "completed");
    assert.equal(withdrawal.amountPaidUsd, "49.900000");
    assert.equal(withdrawal.completedAt, "2026-08-03T00:30:00Z");
  });
});

describe("GroundEarnClient.createPortfolioAddressBookEntry", () => {
  it("whitelists a destination on the environment's Solana rail", async () => {
    const fetchMock = stubGroundFetch({
      status: 201,
      body: { entry: "9492b59c-05e8-4aec-bce7-7b64253f8fae" },
    });

    const result = await client.createPortfolioAddressBookEntry(productionCtx, {
      address: "DestAddr1111111111111111111111111111111111",
      label: "Ops treasury",
    });

    assert.equal(requestUrl(fetchMock), "https://production.groundtech.co/v2/address-book/entries");
    assert.deepEqual(requestBody(fetchMock), {
      address: "DestAddr1111111111111111111111111111111111",
      chain: "solana",
      label: "Ops treasury",
    });
    assert.deepEqual(result, { entryRef: "9492b59c-05e8-4aec-bce7-7b64253f8fae" });
  });
});
