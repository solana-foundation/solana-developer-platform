import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { wellKnownMint } from "@sdp/types";
import {
  HASTRA_DEPLOYMENTS,
  hastraDeployment,
  hastraDepositMints,
  isHastraDepositMint,
} from "@sdp/types/hastra-programs";
import {
  EARN_PROGRAM_SOLANA_PAYOUT_TOKENS,
  EARN_PROVIDER_DEPLOYED_CLUSTERS,
  EARN_PROVIDER_DEPOSIT_FLOOR_SUPPORT,
  EARN_PROVIDER_DEPOSIT_SETTLEMENT,
  EARN_PROVIDER_DEPOSIT_SLIPPAGE_FLOOR,
  EARN_PROVIDER_DEPOSIT_STYLE,
  EARN_PROVIDER_SURFACING,
  EARN_PROVIDER_WITHDRAW_SLIPPAGE_FLOOR,
  EARN_PROVIDER_WITHDRAWAL_SETTLEMENT,
  earnDepositSlippagePolicy,
} from "@sdp/types/provider-access";
import { isStrategyWithinDeclaredSupport } from "../../support";
import { HastraEarnClient } from "./client";

const client = new HastraEarnClient();
const MAINNET = HASTRA_DEPLOYMENTS["mainnet-beta"];
assert.ok(MAINNET, "test premise: Hastra's verified mainnet deployment is registered");
const MAINNET_PRIME_MINT = MAINNET.primeMint;

function stubMetricsFeed() {
  return mock.method(globalThis, "fetch", async () =>
    Response.json({
      wylds_card: { wylds_ratio: "1.0050906525492219" },
      prime_card: {
        mint_address_by_chain: { solana: MAINNET_PRIME_MINT },
        vault_balance_by_chain: { solana: "130615211.729093" },
      },
      demo_prime_card: {
        tokens: [{ token: "prime", effective_rate: "6.1336" }],
      },
    })
  );
}

afterEach(() => mock.restoreAll());

describe("Hastra deployment registry", () => {
  it("pins the verified v0.0.6 programs and token mints on mainnet only", () => {
    assert.deepEqual(MAINNET, {
      vaultMintProgramAddress: "9WUyNREiPDMgwMh5Gt81Fd3JpiCKxpjZ5Dpq9Bo1RhMV",
      vaultStakeProgramAddress: "97V7JsExNC6yFWu5KjK1FLfVkNVvtMpAFL5QkLWKEGxY",
      wYldsMint: "8fr7WGTVFszfyNWRMXj6fRjZZAnDwmXwEpCrtzmUkdih",
      primeMint: "3b8X44fLF9ooXaUm3hhSgjpmVs6rZZ3pPoGnGahc3Uu7",
      decimals: 6,
      release: "v0.0.6",
      sourceCommit: "121e4cc600b976a97faa018359e00bda48113ec2",
    });
    assert.equal(hastraDeployment("devnet"), null);
    assert.deepEqual(hastraDepositMints("devnet"), []);
  });

  it("admits only mainnet USDC as a deposit mint", () => {
    const mainnetUsdc = wellKnownMint("USDC", "mainnet-beta");
    const devnetUsdc = wellKnownMint("USDC", "devnet");
    assert.ok(mainnetUsdc);
    assert.ok(devnetUsdc);
    assert.deepEqual(hastraDepositMints("mainnet-beta"), [mainnetUsdc]);
    assert.equal(isHastraDepositMint(mainnetUsdc, "mainnet-beta"), true);
    assert.equal(isHastraDepositMint(devnetUsdc, "mainnet-beta"), false);
  });
});

describe("Hastra provider policy", () => {
  it("registers a dormant mainnet-only vault-direct provider", () => {
    assert.equal(EARN_PROVIDER_SURFACING.hastra, false);
    assert.equal(EARN_PROVIDER_DEPOSIT_STYLE.hastra, "vault_direct");
    assert.deepEqual(EARN_PROVIDER_DEPLOYED_CLUSTERS.hastra, ["mainnet-beta"]);
    assert.deepEqual(EARN_PROGRAM_SOLANA_PAYOUT_TOKENS.hastra, []);
  });

  it("states atomic ordinary settlement and the executable slippage contracts", () => {
    assert.equal(EARN_PROVIDER_DEPOSIT_SETTLEMENT.hastra, "atomic");
    assert.equal(EARN_PROVIDER_WITHDRAWAL_SETTLEMENT.hastra, "atomic");
    assert.equal(EARN_PROVIDER_DEPOSIT_FLOOR_SUPPORT.hastra, "unsupported");
    assert.equal(EARN_PROVIDER_DEPOSIT_SLIPPAGE_FLOOR.hastra, null);
    assert.equal(earnDepositSlippagePolicy("hastra", "production"), null);
    assert.deepEqual(EARN_PROVIDER_WITHDRAW_SLIPPAGE_FLOOR.hastra, {
      defaultToleranceBps: 50,
    });
  });
});

describe("HastraEarnClient", () => {
  it("catalogues no native sandbox strategy", async () => {
    const fetch = stubMetricsFeed();
    assert.deepEqual(await client.listStrategies({ environment: "sandbox", env: {} }), []);
    assert.equal(fetch.mock.callCount(), 0);
  });

  it("catalogues exactly one PRIME RWA strategy with issuer-published live figures", async () => {
    stubMetricsFeed();
    const snapshots = await client.listStrategies({ environment: "production", env: {} });
    assert.equal(snapshots.length, 1);
    const snapshot = snapshots[0];
    assert.ok(snapshot);

    assert.equal(snapshot.providerReference, MAINNET.primeMint);
    assert.equal(snapshot.name, "Hastra PRIME");
    assert.equal(snapshot.sourceKind, "rwa");
    assert.equal(snapshot.underlyingSource, "figure-democratized-prime-heloc");
    assert.deepEqual(snapshot.depositMints, [wellKnownMint("USDC", "mainnet-beta")]);
    assert.equal(snapshot.shareMint, MAINNET.primeMint);
    assert.equal(snapshot.hostCluster, "mainnet-beta");
    assert.equal(snapshot.apyType, "variable");
    assert.equal(snapshot.currentApy, "0.061336");
    assert.equal(snapshot.liquidityTerm, "delayed");
    assert.equal(snapshot.redemptionDelayDays, undefined);
    assert.deepEqual(snapshot.riskMetadata, {
      curator: "hastra",
      issuer: "Hastra",
      yieldSource: "Figure Democratized Prime HELOC pool",
      wrapperAsset: "wYLDS",
      priceOracle: "Chainlink Data Streams",
      programRelease: "v0.0.6",
      tvlUsd: 131_280_128.38964885,
      parExit: "PRIME to wYLDS atomically, then Hastra operator-mediated redemption",
      optionalDexExit:
        "PRIME to wYLDS to USDC through Jupiter when enabled by the integrating deployment",
    });
    assert.equal(isStrategyWithinDeclaredSupport(client.declaredSupport, snapshot), true);
  });

  it("refreshes the same APY and Solana TVL without replacing static metadata", async () => {
    stubMetricsFeed();
    assert.deepEqual(await client.listStrategyMetrics({ environment: "production", env: {} }), [
      {
        providerReference: MAINNET.primeMint,
        currentApy: "0.061336",
        riskMetadata: { tvlUsd: 131_280_128.38964885 },
      },
    ]);
  });

  it("does not call the mainnet feed for sandbox metrics", async () => {
    const fetch = stubMetricsFeed();
    assert.deepEqual(await client.listStrategyMetrics({ environment: "sandbox", env: {} }), []);
    assert.equal(fetch.mock.callCount(), 0);
  });
});
