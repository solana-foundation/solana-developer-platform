import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { wellKnownMint } from "@sdp/types";
import {
  isVedaDeployed,
  VEDA_DEPLOYMENTS,
  VEDA_DEPOSIT_TOKEN_SYMBOLS,
  vedaDeployment,
  vedaDepositMints,
} from "@sdp/types/veda-programs";
import { isStrategyWithinDeclaredSupport } from "../../support";
import type { ProviderStrategySnapshot } from "../../types";
import { VedaEarnClient } from "./client";

const client = new VedaEarnClient();

const USDC_DEVNET = wellKnownMint("USDC", "devnet") as string;
const USDC_MAINNET = wellKnownMint("USDC", "mainnet-beta") as string;
const USDT_MAINNET = wellKnownMint("USDT", "mainnet-beta") as string;
const SOL_MINT = "So11111111111111111111111111111111111111112";

function snapshot(overrides: Partial<ProviderStrategySnapshot>): ProviderStrategySnapshot {
  return {
    providerReference: "vault-state-address",
    name: "Veda USDC",
    sourceKind: "defi",
    depositMints: [USDC_DEVNET],
    apyType: "variable",
    liquidityTerm: "instant",
    hostCluster: "devnet",
    ...overrides,
  };
}

describe("VedaEarnClient.declaredSupport", () => {
  it("declares USDC only, sourced from the shared registry", () => {
    assert.deepEqual(client.declaredSupport.depositTokens, ["USDC"]);
    assert.deepEqual([...VEDA_DEPOSIT_TOKEN_SYMBOLS], [...client.declaredSupport.depositTokens]);
  });

  /**
   * `rwa` is the filter an integrator uses to find instruments with real-world
   * backing, so claiming it is SDP vouching rather than quoting. Nothing Veda
   * publishes on-chain establishes it, so the envelope must not carry it — this
   * is the same rule that keeps every Kamino snapshot `defi`.
   */
  it("does not claim the rwa source kind", () => {
    assert.deepEqual(client.declaredSupport.sourceKinds, ["defi"]);
    assert.equal(
      isStrategyWithinDeclaredSupport(client.declaredSupport, snapshot({ sourceKind: "rwa" })),
      false
    );
  });

  it("admits a USDC vault on either cluster", () => {
    for (const mint of [USDC_DEVNET, USDC_MAINNET]) {
      assert.equal(
        isStrategyWithinDeclaredSupport(client.declaredSupport, snapshot({ depositMints: [mint] })),
        true
      );
    }
  });

  it("refuses assets outside the envelope, including a second stablecoin", () => {
    for (const mint of [USDT_MAINNET, SOL_MINT]) {
      assert.equal(
        isStrategyWithinDeclaredSupport(client.declaredSupport, snapshot({ depositMints: [mint] })),
        false
      );
    }
  });

  /**
   * `isStrategyWithinDeclaredSupport` requires EVERY mint to be in the
   * envelope, so a vault that also accepts something SDP does not front is
   * refused whole rather than admitted on its USDC leg. Pinned because the
   * catalogue read has to screen the mint list itself, not hand a mixed list up.
   */
  it("refuses a mixed mint list rather than admitting its supported half", () => {
    assert.equal(
      isStrategyWithinDeclaredSupport(
        client.declaredSupport,
        snapshot({ depositMints: [USDC_DEVNET, SOL_MINT] })
      ),
      false
    );
  });

  it("still throws NOT_IMPLEMENTED for listStrategies until the catalogue read lands", async () => {
    await assert.rejects(client.listStrategies({ env: {}, environment: "sandbox" }), /veda/);
  });
});

describe("the Veda deployment registry", () => {
  /**
   * The load-bearing state of this stack, asserted rather than assumed: SDP has
   * no confirmed Veda deployment, so every cluster reads as undeployed and
   * every downstream path fails closed. When Veda confirms addresses, this test
   * is the one that changes — deliberately, and with the confirmation in the
   * pull request that changes it.
   */
  it("reports no confirmed deployment on any cluster", () => {
    assert.equal(vedaDeployment("devnet"), null);
    assert.equal(vedaDeployment("mainnet-beta"), null);
    assert.equal(isVedaDeployed("devnet"), false);
    assert.equal(isVedaDeployed("mainnet-beta"), false);
  });

  it("states both clusters explicitly, so a missing one is a visible gap", () => {
    assert.deepEqual(Object.keys(VEDA_DEPLOYMENTS).sort(), ["devnet", "mainnet-beta"]);
  });

  it("resolves declared deposit symbols to each cluster's own mint", () => {
    assert.deepEqual(vedaDepositMints("devnet"), [USDC_DEVNET]);
    assert.deepEqual(vedaDepositMints("mainnet-beta"), [USDC_MAINNET]);
    assert.notEqual(USDC_DEVNET, USDC_MAINNET);
  });
});
