import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { wellKnownMint } from "@sdp/types";
import { isStrategyWithinDeclaredSupport } from "./support";
import type { EarnDeclaredStrategySupport } from "./types";

const SUPPORT: EarnDeclaredStrategySupport = {
  sourceKinds: ["defi"],
  depositTokens: ["USDC", "USDG"],
};

const USDC_MAINNET = wellKnownMint("USDC", "mainnet-beta") as string;
const USDC_DEVNET = wellKnownMint("USDC", "devnet") as string;
const USDT_MAINNET = wellKnownMint("USDT", "mainnet-beta") as string;

describe("isStrategyWithinDeclaredSupport", () => {
  it("accepts declared tokens on either cluster", () => {
    for (const mint of [USDC_MAINNET, USDC_DEVNET]) {
      assert.equal(
        isStrategyWithinDeclaredSupport(SUPPORT, { sourceKind: "defi", depositMints: [mint] }),
        true
      );
    }
  });

  it("rejects an undeclared source kind", () => {
    assert.equal(
      isStrategyWithinDeclaredSupport(SUPPORT, {
        sourceKind: "rwa",
        depositMints: [USDC_MAINNET],
      }),
      false
    );
  });

  it("rejects when any mint is outside the declared tokens", () => {
    assert.equal(
      isStrategyWithinDeclaredSupport(SUPPORT, {
        sourceKind: "defi",
        depositMints: [USDC_MAINNET, USDT_MAINNET],
      }),
      false
    );
  });

  it("fails closed on unknown mints and empty mint lists", () => {
    assert.equal(
      isStrategyWithinDeclaredSupport(SUPPORT, {
        sourceKind: "defi",
        depositMints: ["NotARealMint1111111111111111111111111111111"],
      }),
      false
    );
    assert.equal(
      isStrategyWithinDeclaredSupport(SUPPORT, { sourceKind: "defi", depositMints: [] }),
      false
    );
  });
});
