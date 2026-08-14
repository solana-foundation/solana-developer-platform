import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { wellKnownMint } from "@sdp/types";
import { SdpEarnError, type SdpEarnErrorCode } from "../../errors";
import type { EarnRuntimeContext } from "../../types";
import { distillGroundYieldSource, GroundEarnClient, type GroundYieldSource } from "./client";

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
  // Ground can bridge Solana deposits to an Ethereum-hosted yield source. The
  // sync indexes the row; API visibility is a separate route-layer policy.
  chain: "ethereum_sepolia",
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

  it("uses the production host and key, and skips tokens Ground cannot route on Solana", async () => {
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
    // The USDT source has a mainnet mint, but Ground's Solana rails are
    // USDC-only — it must never enter the catalogue, even in production.
    assert.deepEqual(
      strategies.map((s) => s.depositMints),
      [[wellKnownMint("USDC", "mainnet-beta")]]
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

describe("distillGroundYieldSource", () => {
  const distill = (
    overrides: Record<string, unknown>,
    environment: "sandbox" | "production" = "sandbox"
  ) => distillGroundYieldSource(yieldSource(overrides) as GroundYieldSource, environment);

  it("names the gate that keeps each source out of the catalogue", () => {
    assert.deepEqual(distill({ mode: "buy_only" }), {
      outcome: "dropped",
      reason: "inactive_mode",
    });
    assert.deepEqual(distill({ mode: "emergency_freeze" }), {
      outcome: "dropped",
      reason: "inactive_mode",
    });
    // Rail-gated, not mint-gated: USDT drops even in production, where a
    // well-known mint exists — Ground's Solana rails carry USDC only. Ordered
    // USDT source wherever it is hosted.
    assert.deepEqual(distill({ depositToken: "usdt" }, "production"), {
      outcome: "dropped",
      reason: "not_solana_routable",
    });
  });

  it("indexes routable sources regardless of where Ground hosts them", () => {
    for (const chain of ["ethereum", "ethereum_sepolia", "base", "solana", null, undefined]) {
      assert.equal(distill({ chain }).outcome, "catalogued", `chain=${String(chain)}`);
    }
  });

  it("catalogues an active USDC source with the snapshot listStrategies publishes", () => {
    const distilled = distill({});
    if (distilled.outcome !== "catalogued") {
      assert.fail(`expected catalogued, got dropped: ${distilled.reason}`);
    }
    assert.equal(distilled.snapshot.providerReference, "morpho-gauntlet-usdc");
    assert.equal(distilled.snapshot.sourceKind, "defi");
    assert.equal(distilled.snapshot.riskMetadata?.curator, "gauntlet");
    assert.deepEqual(distilled.snapshot.depositMints, [wellKnownMint("USDC", "devnet")]);
  });
});

/**
 * THE Solana-only boundary test. Every wallet flow must send the environment's
 * Solana chain from GROUND_SOLANA_CHAINS — never a caller value — so this
 * drives every body-sending client method in BOTH environments and walks every
 * request body: any chain-keyed field must equal the pinned chain, and no
 * non-Solana chain name may appear anywhere in any payload. A new method that
 * hardcodes or accepts a chain fails here without anyone remembering to review
 * for it.
 */
describe("Solana-only boundary — every request pins the environment's chain", () => {
  const FOREIGN_CHAIN = /ethereum|sepolia|base|arbitrum|polygon|optimism|avalanche/i;

  /** Every chain-keyed entry in a JSON body, with its path for the failure message. */
  function chainFields(value: unknown, path = "$"): Array<{ path: string; value: unknown }> {
    if (Array.isArray(value)) {
      return value.flatMap((item, index) => chainFields(item, `${path}[${index}]`));
    }
    if (value !== null && typeof value === "object") {
      return Object.entries(value).flatMap(([key, nested]) => {
        const nestedPath = `${path}.${key}`;
        const own = /chain/i.test(key) ? [{ path: nestedPath, value: nested }] : [];
        return [...own, ...chainFields(nested, nestedPath)];
      });
    }
    return [];
  }

  const CASES: Array<{
    label: string;
    reply: unknown;
    call: (ctx: EarnRuntimeContext) => Promise<unknown>;
    carriesChain: boolean;
  }> = [
    {
      label: "createPortfolioWallet",
      reply: groundWallet({ status: "creating" }),
      call: (ctx) =>
        client.createPortfolioWallet(ctx, {
          label: "boundary",
          allocations: { usdc: [{ yieldSourceId: "morpho-gauntlet-usdc", pct: 100 }] },
          requestId: "55555555-5555-4555-8555-555555555555",
        }),
      carriesChain: false,
    },
    {
      label: "updatePortfolioStrategy",
      reply: { strategyAllocations: {} },
      call: (ctx) =>
        client.updatePortfolioStrategy(ctx, {
          providerWalletRef: "wal_1",
          allocations: { usdc: [{ yieldSourceId: "morpho-gauntlet-usdc", pct: 100 }] },
        }),
      carriesChain: false,
    },
    {
      label: "previewPortfolioWithdrawal",
      reply: { feeUsd: "0", withdrawableUsd: "10", totalUsdAfterWithdrawal: "9" },
      call: (ctx) =>
        client.previewPortfolioWithdrawal(ctx, {
          providerWalletRef: "wal_1",
          amountUsd: "1.00",
          token: "usdc",
        }),
      carriesChain: true,
    },
    {
      label: "createPortfolioWithdrawal",
      reply: groundWithdrawal(),
      call: (ctx) =>
        client.createPortfolioWithdrawal(ctx, {
          providerWalletRef: "wal_1",
          requestId: "3f1f2b6e-7a51-4b8e-9a4e-6f2d1c0b9a87",
          amountUsd: "1.00",
          token: "usdc",
          destinationAddress: "DestAddr1111111111111111111111111111111111",
        }),
      carriesChain: true,
    },
    {
      label: "createPortfolioAddressBookEntry",
      reply: { entry: "abe_1" },
      call: (ctx) =>
        client.createPortfolioAddressBookEntry(ctx, {
          address: "DestAddr1111111111111111111111111111111111",
          label: "boundary",
        }),
      carriesChain: true,
    },
  ];

  const EXPECTED_CHAIN = { sandbox: "solana_devnet", production: "solana" } as const;

  for (const [environment, ctx] of [
    ["sandbox", sandboxCtx],
    ["production", productionCtx],
  ] as const) {
    it(`${environment}: every body-sending method pins ${EXPECTED_CHAIN[environment]}`, async () => {
      let chainCarryingBodies = 0;
      for (const testCase of CASES) {
        mock.restoreAll();
        const fetchMock = stubGroundFetch({ body: testCase.reply });
        await testCase.call(ctx);

        const body = requestBody(fetchMock);
        const fields = chainFields(body);
        if (testCase.carriesChain) {
          chainCarryingBodies += 1;
          assert.ok(fields.length > 0, `${testCase.label}: expected a chain field in the body`);
        }
        for (const field of fields) {
          assert.equal(
            field.value,
            EXPECTED_CHAIN[environment],
            `${testCase.label}: ${field.path} must be ${EXPECTED_CHAIN[environment]}, got ${String(field.value)}`
          );
        }
        assert.doesNotMatch(
          JSON.stringify(body),
          FOREIGN_CHAIN,
          `${testCase.label}: request body must never name a non-Solana chain`
        );
      }
      // Guard the walker itself: if a rename blinds /chain/i, this fails loud
      // instead of the assertions above silently passing on zero matches.
      assert.equal(chainCarryingBodies, 3);
    });
  }
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

  /**
   * The create path deliberately has NO mint-when-absent fallback (PRO-1670):
   * a server-minted id is fresh per attempt, so it would guarantee the
   * double-provision it appears to guard against. `requestId` is required by
   * `EarnPortfolioWalletCreateInput`, so the omission is a type error rather
   * than a silent downgrade — this test pins that whatever the caller sends is
   * exactly what reaches the wire, including a value the type system cannot
   * catch at a JS boundary.
   *
   * The UPDATE path keeps its fallback (see updatePortfolioStrategy below):
   * re-applying the same allocations is a provider no-op, so an absent key
   * costs a duplicate mutation rather than a duplicate wallet.
   */
  it("never mints a requestId of its own on create", async () => {
    const fetchMock = stubGroundFetch({ body: groundWallet({ status: "creating" }) });

    await client.createPortfolioWallet(sandboxCtx, {
      label: "SDP Earn",
      allocations: {},
      requestId: undefined as unknown as string,
    });

    assert.equal(requestBody(fetchMock).requestId, undefined);
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

  // The provider is the source of truth for what is happening to the money.
  // Consumers read the neutral `activity`, so this table is the ONE place
  // Ground's vocabulary is interpreted — a UI must never re-derive it.
  it("names the operation behind every busy status, and never guesses on an unknown one", async () => {
    const observed: Array<{ status: string; activity: string | undefined }> = [];
    for (const providerStatus of [
      "idle",
      "creating",
      "withdrawal_active",
      "rebalance_active",
      "withdrawal_and_rebalance_active",
      "failed",
      // Ground adds a status this build has never seen.
      "some_future_state",
    ]) {
      mock.restoreAll();
      stubGroundFetch({ body: groundWallet({ status: providerStatus }) });
      const snapshot = await client.getPortfolioWallet(sandboxCtx, {
        providerWalletRef: "wal_1",
      });
      assert.equal(snapshot.providerStatus, providerStatus, "raw status is always relayed");
      observed.push({ status: snapshot.status, activity: snapshot.activity });
    }

    assert.deepEqual(observed, [
      { status: "ready", activity: undefined },
      { status: "creating", activity: undefined },
      { status: "busy", activity: "withdrawing" },
      { status: "busy", activity: "rebalancing" },
      // A concurrent rebalance never masks the withdrawal the reader waits on.
      { status: "busy", activity: "withdrawing" },
      { status: "failed", activity: undefined },
      // Unknown ⇒ busy so funds stay visible and mutations wait, but NO
      // activity: nothing may claim to know what an unseen status means.
      { status: "busy", activity: undefined },
    ]);
  });

  // ADR 0002 invariant 5: no other chain's rails may reach a wire type or the
  // UI. Ground names non-yield positions after the chain the value sits on, so
  // these labels are synthesized rather than passed through. Payload shapes here
  // are the real ones observed against Ground's sandbox.
  it("never surfaces a provider position label carrying a non-Solana chain", async () => {
    stubGroundFetch({
      body: groundWallet({
        positions: [
          {
            id: "cash:ethereum_sepolia:usdt",
            kind: "cash",
            chain: "ethereum_sepolia",
            label: "USDT (Ethereum Sepolia)",
            token: "usdt",
            valueUsd: "5.000000",
          },
          {
            id: "bridge_1",
            kind: "bridge",
            chain: "base",
            label: "USDC bridging via Base",
            token: "usdc",
            valueUsd: "3.000000",
          },
          {
            id: "payout_1",
            kind: "external_payout",
            chain: "ethereum",
            label: "Payout to Ethereum",
            valueUsd: "1.000000",
          },
          {
            id: "future_1",
            kind: "some_future_kind",
            label: "Restaked on Arbitrum",
            valueUsd: "2.000000",
          },
        ],
      }),
    });

    const snapshot = await client.getPortfolioWallet(sandboxCtx, { providerWalletRef: "wal_1" });

    assert.deepEqual(
      snapshot.positions.map((position) => [position.kind, position.label, position.valueUsd]),
      [
        ["cash", "Cash (USDT)", "5.000000"],
        ["bridge", "In transit (USDC)", "3.000000"],
        ["external_payout", "Withdrawal in progress", "1.000000"],
        ["unknown", "Other holding", "2.000000"],
      ]
    );
    // The values still add up — only the chain wording is withheld.
    assert.equal(
      snapshot.positions.reduce((sum, position) => sum + Number(position.valueUsd), 0),
      11
    );
    const rendered = JSON.stringify(snapshot);
    for (const chain of ["sepolia", "ethereum", "base", "arbitrum"]) {
      assert.ok(
        !rendered.toLowerCase().includes(chain),
        `snapshot leaked non-Solana chain "${chain}"`
      );
    }
  });

  it("keeps the provider's own label for yield sources, which joins to the catalogue", async () => {
    stubGroundFetch({ body: groundWallet() });

    const snapshot = await client.getPortfolioWallet(sandboxCtx, { providerWalletRef: "wal_1" });

    assert.equal(snapshot.positions[0]?.label, "Morpho Gauntlet USDC");
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
  // A shared Ground wallet is fundable on non-Solana rails (the sandbox USDT
  // faucet is Sepolia-only), so the deposits page can carry rows whose
  // provenance belongs to another chain. ADR 0002 invariant 5: the VALUE
  // renders, the foreign rail's identifiers never do — otherwise an Ethereum
  // 0x address reaches the dashboard and an Ethereum tx hash ships in a field
  // named transactionSignature.
  it("withholds another rail's from-address and tx hash, keeping the value visible", async () => {
    stubGroundFetch({
      body: page([
        {
          id: "dep_sepolia",
          amount: "50.000000",
          token: "usdt",
          chain: "ethereum_sepolia",
          fromAddress: "0x52908400098527886E0F7030069857D2E4169EE7",
          txHash: "0x88df016429689c079f3b2f6ad39fa052532c56795b733da78a91ebe6a713944b",
          status: "completed",
          createdAt: "2026-08-04T10:00:00Z",
          completedAt: "2026-08-04T10:03:00Z",
        },
        {
          // No chain reported: never guess — withhold identifiers, keep value.
          id: "dep_unreported",
          amount: "10.000000",
          token: "usdc",
          fromAddress: "SomeAddr11111111111111111111111111111111111",
          txHash: "5igSig999",
          status: "completed",
          createdAt: "2026-08-04T11:00:00Z",
          completedAt: null,
        },
      ]),
    });

    const result = await client.listPortfolioDeposits(sandboxCtx, {
      providerWalletRef: "wal_1",
    });

    const [sepolia, unreported] = result.deposits;
    assert.equal(sepolia.id, "dep_sepolia");
    assert.equal(sepolia.amountUsd, "50.000000");
    assert.equal(sepolia.status, "completed");
    assert.equal(sepolia.fromAddress, undefined);
    assert.equal(sepolia.transactionSignature, undefined);
    assert.equal(unreported.fromAddress, undefined);
    assert.equal(unreported.transactionSignature, undefined);
    assert.doesNotMatch(JSON.stringify(result), /0x[0-9a-fA-F]/);
  });

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

  // PRO-1675: the liquidity form. Ground keys it off the field's ABSENCE, so
  // this asserts the key is missing rather than merely falsy — `null` and `0`
  // are different questions and `0` is off `parseUsdAmount`'s pattern anyway.
  it("OMITS amountUsd entirely when asked for the lane maximum", async () => {
    const fetchMock = stubGroundFetch({
      body: {
        amountRequestedUsd: null,
        feeUsd: "0.100000",
        withdrawableUsd: "412.500000",
        totalUsdAfterWithdrawal: "412.500000",
      },
    });

    const preview = await client.previewPortfolioWithdrawal(sandboxCtx, {
      providerWalletRef: "wal_1",
      token: "usdc",
    });

    const body = requestBody(fetchMock);
    assert.deepEqual(body, { destinationChain: "solana_devnet", token: "usdc" });
    assert.equal("amountUsd" in body, false);
    assert.equal(preview.withdrawableUsd, "412.500000");
    assert.equal(preview.amountRequestedUsd, undefined);
  });

  it("still refuses a token Ground cannot route to Solana, amount or not", async () => {
    const fetchMock = stubGroundFetch({ body: {} });

    await assert.rejects(
      client.previewPortfolioWithdrawal(sandboxCtx, {
        providerWalletRef: "wal_1",
        token: "usdt",
      }),
      earnError("BAD_REQUEST")
    );
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  // The 409 body is the only place the provider says HOW short a request is.
  // Losing it is why an over-request used to read as "…failed with status 409".
  it("carries the 409 lane balance onto SdpEarnError.details", async () => {
    stubGroundFetch({
      status: 409,
      body: {
        error: { code: "insufficient_funds", message: "insufficient funds" },
        balance: { totalUsd: "900.00", withdrawableUsd: "412.50", reservedUsd: "487.50" },
      },
    });

    await assert.rejects(
      client.previewPortfolioWithdrawal(sandboxCtx, {
        providerWalletRef: "wal_1",
        amountUsd: "800",
        token: "usdc",
      }),
      (error: unknown) => {
        const earn = error as { code: string; details?: Record<string, unknown> };
        assert.equal(earn.code, "CONFLICT");
        assert.deepEqual(earn.details?.balance, {
          totalUsd: "900.00",
          withdrawableUsd: "412.50",
          reservedUsd: "487.50",
        });
        // The transport's own facts are not overwritable by the normalizer.
        assert.equal(earn.details?.provider, "ground");
        assert.equal(earn.details?.providerStatus, 409);
        return true;
      }
    );
  });

  it("normalizes a nested, numeric balance and declines a 409 that carries none", async () => {
    stubGroundFetch(
      {
        status: 409,
        // Ground nests the payload inconsistently across endpoints, and sends
        // JSON numbers here where the success payload uses strings.
        body: { error: { message: "nope", balance: { withdrawableUsd: 412.5 } } },
      },
      // A conflict with no balance (Ground's `request_id_conflict` shape) must
      // pass through untouched rather than gaining an empty `balance`.
      { status: 409, body: { error: { message: "request_id_conflict" } } }
    );

    const preview = () =>
      client.previewPortfolioWithdrawal(sandboxCtx, {
        providerWalletRef: "wal_1",
        amountUsd: "800",
        token: "usdc",
      });

    await assert.rejects(preview(), (error: unknown) => {
      const earn = error as { details?: Record<string, unknown> };
      assert.deepEqual(earn.details?.balance, { withdrawableUsd: "412.5" });
      return true;
    });

    await assert.rejects(preview(), (error: unknown) => {
      const earn = error as { message: string; details?: Record<string, unknown> };
      assert.equal(earn.message, "request_id_conflict");
      assert.equal("balance" in (earn.details ?? {}), false);
      return true;
    });
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

describe("GroundEarnClient path-segment encoding", () => {
  const TRAVERSAL = "../../wallets?";

  /**
   * Every request carries the account-wide Ground API key, so a ref that
   * reaches the path unencoded is a request-forgery primitive: the URL parser
   * resolves `..`, retargeting an authenticated call at another endpoint.
   * These assert the escape does not happen — on unencoded interpolation the
   * URL collapses to `/v2/wallets?/...` and every one of them fails.
   */
  const assertContained = (url: string, prefix: string) => {
    assert.ok(url.startsWith(prefix), `escaped its path prefix: ${url}`);
    assert.ok(!url.includes("/../"), `unresolved traversal survived: ${url}`);
  };

  it("keeps a traversal ref inside the activities segment when voting", async () => {
    const fetchMock = stubGroundFetch({ body: { action: "approve", approved: true } });

    await client.submitWithdrawalApprovalVote(sandboxCtx, {
      approvalRef: TRAVERSAL,
      action: "approve",
      stamp: "s",
      providerRequest: {},
    });

    assertContained(requestUrl(fetchMock), "https://sandbox.groundtech.co/v2/turnkey/activities/");
    assert.ok(requestUrl(fetchMock).endsWith("/vote"));
  });

  it("keeps a traversal wallet ref inside the wallets segment", async () => {
    const fetchMock = stubGroundFetch({ body: groundWallet() });

    await client.getPortfolioWallet(sandboxCtx, { providerWalletRef: TRAVERSAL });

    assertContained(requestUrl(fetchMock), "https://sandbox.groundtech.co/v2/wallets/");
  });

  it("keeps a traversal withdrawal ref inside the withdrawals segment", async () => {
    const fetchMock = stubGroundFetch({ body: groundWithdrawal() });

    await client.getPortfolioWithdrawal(sandboxCtx, {
      providerWalletRef: "wal_1",
      withdrawalRef: TRAVERSAL,
    });

    assertContained(
      requestUrl(fetchMock),
      "https://sandbox.groundtech.co/v2/wallets/wal_1/withdrawals/"
    );
  });

  it("keeps a traversal wallet ref inside the deposits URL built via URL()", async () => {
    const fetchMock = stubGroundFetch({ body: page([]) });

    await client.listPortfolioDeposits(sandboxCtx, { providerWalletRef: TRAVERSAL });

    assertContained(requestUrl(fetchMock), "https://sandbox.groundtech.co/v2/wallets/");
  });

  it("rejects a blank reference before any network call", async () => {
    const fetchMock = stubGroundFetch({ body: groundWallet() });

    await assert.rejects(
      client.getPortfolioWallet(sandboxCtx, { providerWalletRef: "   " }),
      earnError("BAD_REQUEST", /wallet reference is required/)
    );
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it("leaves ordinary provider ids byte-identical", async () => {
    const fetchMock = stubGroundFetch({ body: groundWallet() });

    await client.getPortfolioWallet(sandboxCtx, {
      providerWalletRef: "5fe239ad-0153-4a43-b784-95feae040930",
    });

    assert.equal(
      requestUrl(fetchMock),
      "https://sandbox.groundtech.co/v2/wallets/5fe239ad-0153-4a43-b784-95feae040930"
    );
  });
});

describe("GroundEarnClient Solana routability guard", () => {
  it("refuses a USDT withdrawal preview before any network call", async () => {
    const fetchMock = stubGroundFetch({ body: {} });

    await assert.rejects(
      client.previewPortfolioWithdrawal(sandboxCtx, {
        providerWalletRef: "wal_1",
        amountUsd: "1",
        token: "usdt",
      }),
      earnError("BAD_REQUEST", /USDC only/)
    );
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it("refuses a USDT withdrawal create before any network call", async () => {
    const fetchMock = stubGroundFetch({ body: {} });

    await assert.rejects(
      client.createPortfolioWithdrawal(sandboxCtx, {
        providerWalletRef: "wal_1",
        requestId: "44444444-4444-4444-8444-444444444444",
        amountUsd: "1",
        token: "usdt",
        destinationAddress: "DestAddr1111111111111111111111111111111111",
      }),
      earnError("BAD_REQUEST", /USDC only/)
    );
    assert.equal(fetchMock.mock.callCount(), 0);
  });
});

describe("GroundEarnClient withdrawal approval parking", () => {
  it("folds a pending_customer_approval payout leg into pending_approval", async () => {
    stubGroundFetch({
      body: groundWithdrawal({
        payoutLegs: [{ status: "pending_customer_approval", steps: [{ state: "created" }] }],
      }),
    });

    const withdrawal = await client.getPortfolioWithdrawal(sandboxCtx, {
      providerWalletRef: "wal_1",
      withdrawalRef: "wd_1",
    });

    assert.equal(withdrawal.status, "pending_approval");
  });

  it("reads step state when the leg status alone still says processing", async () => {
    stubGroundFetch({
      body: groundWithdrawal({
        payoutLegs: [{ status: "processing", steps: [{ state: "pending_customer_approval" }] }],
      }),
    });

    const withdrawal = await client.getPortfolioWithdrawal(sandboxCtx, {
      providerWalletRef: "wal_1",
      withdrawalRef: "wd_1",
    });

    assert.equal(withdrawal.status, "pending_approval");
  });

  it("never overrides a terminal status with stale leg state", async () => {
    stubGroundFetch({
      body: groundWithdrawal({
        status: "completed",
        completedAt: "2026-08-03T00:30:00Z",
        payoutLegs: [{ status: "pending_customer_approval" }],
      }),
    });

    const withdrawal = await client.getPortfolioWithdrawal(sandboxCtx, {
      providerWalletRef: "wal_1",
      withdrawalRef: "wd_1",
    });

    assert.equal(withdrawal.status, "completed");
  });

  it("stays processing while legs advance without an approval gate", async () => {
    stubGroundFetch({
      body: groundWithdrawal({
        payoutLegs: [{ status: "processing", steps: [{ state: "processing" }] }],
      }),
    });

    const withdrawal = await client.getPortfolioWithdrawal(sandboxCtx, {
      providerWalletRef: "wal_1",
      withdrawalRef: "wd_1",
    });

    assert.equal(withdrawal.status, "processing");
  });
});

const groundTurnkeyActivity = (overrides: Record<string, unknown> = {}) => ({
  turnkeyActivityId: "act_1",
  status: "ACTIVITY_STATUS_CONSENSUS_NEEDED",
  activityType: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
  activityKind: "withdrawal_payout",
  activityMetadata: {},
  fingerprint: "fp_1",
  firstSeenAt: "2026-08-05T00:00:00Z",
  withdrawalLegId: "leg_1",
  withdrawalId: "wd_1",
  portfolioWalletId: "wal_1",
  destinationChain: "ethereum_sepolia",
  destinationToken: "usdt",
  destinationAddress: "0x000000000000000000000000000000000000dead",
  plannedSourceNativeUnits: "5000000",
  displayAmountNativeUnits: "5000000",
  txChain: "ethereum_sepolia",
  ...overrides,
});

describe("GroundEarnClient.listPendingWithdrawalApprovals", () => {
  it("maps pending Turnkey activities to the neutral approval shape", async () => {
    const fetchMock = stubGroundFetch({ body: { activities: [groundTurnkeyActivity()] } });

    const approvals = await client.listPendingWithdrawalApprovals(sandboxCtx);

    assert.equal(
      requestUrl(fetchMock),
      "https://sandbox.groundtech.co/v2/turnkey/activities/pending"
    );
    assert.deepEqual(approvals, [
      {
        approvalRef: "act_1",
        providerStatus: "ACTIVITY_STATUS_CONSENSUS_NEEDED",
        kind: "withdrawal_payout",
        withdrawalRef: "wd_1",
        withdrawalLegRef: "leg_1",
        providerWalletRef: "wal_1",
        destinationChain: "ethereum_sepolia",
        destinationToken: "usdt",
        destinationAddress: "0x000000000000000000000000000000000000dead",
        amountNativeUnits: "5000000",
        firstSeenAt: "2026-08-05T00:00:00Z",
      },
    ]);
  });

  it("fails closed before any network call without a key", async () => {
    const fetchMock = stubGroundFetch({ body: { activities: [] } });

    await assert.rejects(
      client.listPendingWithdrawalApprovals({ env: {}, environment: "sandbox" }),
      earnError("PROVIDER_NOT_CONFIGURED")
    );
    assert.equal(fetchMock.mock.callCount(), 0);
  });
});

describe("GroundEarnClient.createWithdrawalApprovalRequest", () => {
  it("returns the provider signing payload verbatim", async () => {
    const stampPayload =
      '{"type":"ACTIVITY_TYPE_APPROVE_ACTIVITY","timestampMs":"1782302400000","organizationId":"suborg_1","parameters":{"fingerprint":"fp_1"}}';
    const fetchMock = stubGroundFetch({
      body: {
        activityId: "act_1",
        action: "approve",
        turnkeyRequest: {
          type: "ACTIVITY_TYPE_APPROVE_ACTIVITY",
          timestampMs: "1782302400000",
          organizationId: "suborg_1",
          parameters: { fingerprint: "fp_1" },
        },
        stampPayload,
      },
    });

    const request = await client.createWithdrawalApprovalRequest(sandboxCtx, {
      approvalRef: "act_1",
      action: "approve",
    });

    assert.equal(
      requestUrl(fetchMock),
      "https://sandbox.groundtech.co/v2/turnkey/activity-approval-request"
    );
    assert.deepEqual(requestBody(fetchMock), { activityId: "act_1", action: "approve" });
    assert.equal(request.approvalRef, "act_1");
    assert.equal(request.signingPayload, stampPayload);
    assert.deepEqual(request.providerRequest, {
      type: "ACTIVITY_TYPE_APPROVE_ACTIVITY",
      timestampMs: "1782302400000",
      organizationId: "suborg_1",
      parameters: { fingerprint: "fp_1" },
    });
  });

  it("maps a not-actionable activity to CONFLICT", async () => {
    stubGroundFetch({
      status: 409,
      body: { error: "Activity is not currently actionable", code: "workflow_conflict" },
    });

    await assert.rejects(
      client.createWithdrawalApprovalRequest(sandboxCtx, {
        approvalRef: "act_1",
        action: "approve",
      }),
      earnError("CONFLICT")
    );
  });
});

describe("GroundEarnClient.submitWithdrawalApprovalVote", () => {
  it("submits a header-pair stamp and reports the approval applied", async () => {
    const fetchMock = stubGroundFetch({
      body: { action: "approve", approved: true, resultStatus: "ACTIVITY_STATUS_COMPLETED" },
    });

    const result = await client.submitWithdrawalApprovalVote(sandboxCtx, {
      approvalRef: "act_1",
      action: "approve",
      stamp: { headerName: "X-Stamp", headerValue: "stamped-by-customer" },
      providerRequest: {
        type: "ACTIVITY_TYPE_APPROVE_ACTIVITY",
        parameters: { fingerprint: "fp_1" },
      },
    });

    assert.equal(
      requestUrl(fetchMock),
      "https://sandbox.groundtech.co/v2/turnkey/activities/act_1/vote"
    );
    assert.deepEqual(requestBody(fetchMock), {
      action: "approve",
      customerApprovalStamp: {
        stampHeaderName: "X-Stamp",
        stampHeaderValue: "stamped-by-customer",
      },
      turnkeyRequest: {
        type: "ACTIVITY_TYPE_APPROVE_ACTIVITY",
        parameters: { fingerprint: "fp_1" },
      },
    });
    assert.deepEqual(result, {
      action: "approve",
      applied: true,
      alreadyResolved: false,
      providerStatus: "ACTIVITY_STATUS_COMPLETED",
    });
  });

  it("passes a string stamp through and reports an already-terminal activity", async () => {
    const fetchMock = stubGroundFetch({
      body: {
        action: "reject",
        rejected: false,
        alreadyTerminal: true,
        status: "ACTIVITY_STATUS_COMPLETED",
      },
    });

    const result = await client.submitWithdrawalApprovalVote(sandboxCtx, {
      approvalRef: "act_1",
      action: "reject",
      stamp: "opaque-stamp",
      providerRequest: {},
    });

    assert.equal(requestBody(fetchMock).customerApprovalStamp, "opaque-stamp");
    assert.deepEqual(result, {
      action: "reject",
      applied: false,
      alreadyResolved: true,
      providerStatus: "ACTIVITY_STATUS_COMPLETED",
    });
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
