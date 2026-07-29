import {
  SOL_MINT,
  type SolanaCluster,
  WELL_KNOWN_TOKEN_BY_MINT,
  WELL_KNOWN_TOKENS,
  type WellKnownToken,
  wellKnownDecimals,
  wellKnownMint,
} from "@sdp/types";
import { describe, expect, it } from "vitest";

// The catalogue lives in @sdp/types, which carries no test runner of its own.
// It is exercised here because the dashboard is its heaviest consumer and this
// suite runs without containers.

const CLUSTERS: SolanaCluster[] = ["devnet", "mainnet-beta"];

describe("WELL_KNOWN_TOKENS", () => {
  it("declares decimals on each mint rather than on the token", () => {
    // Decimals belong to the mint account. Holding one value per token is what
    // made USDS's devnet deployment unrepresentable and forced it to be dropped.
    for (const token of Object.values(WELL_KNOWN_TOKENS)) {
      for (const mint of Object.values(token.mints)) {
        expect(Number.isInteger(mint.decimals), `${token.symbol} decimals`).toBe(true);
        expect(mint.decimals).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("never lets two tokens claim the same mint address", () => {
    const owner = new Map<string, string>();

    for (const token of Object.values(WELL_KNOWN_TOKENS)) {
      for (const mint of Object.values(token.mints)) {
        expect(owner.get(mint.address) ?? token.symbol).toBe(token.symbol);
        owner.set(mint.address, token.symbol);
      }
    }
  });
});

describe("WELL_KNOWN_TOKEN_BY_MINT", () => {
  it("carries the decimals of the mint it was resolved from", () => {
    for (const token of Object.values(WELL_KNOWN_TOKENS)) {
      for (const mint of Object.values(token.mints)) {
        expect(WELL_KNOWN_TOKEN_BY_MINT.get(mint.address)?.decimals).toBe(mint.decimals);
      }
    }
  });

  it("lists both clusters when one address serves both", () => {
    // EURC, JitoSOL, mSOL and bSOL sit at the same address on devnet and
    // mainnet, so the entry has to claim both — dedupe by address, not identity.
    const eurc = WELL_KNOWN_TOKEN_BY_MINT.get(WELL_KNOWN_TOKENS.EURC.mints.devnet.address);

    expect([...(eurc?.clusters ?? [])].sort()).toEqual(["devnet", "mainnet-beta"]);
  });

  it("claims only the one cluster a single-cluster token is deployed on", () => {
    const usdt = WELL_KNOWN_TOKEN_BY_MINT.get(WELL_KNOWN_TOKENS.USDT.mints["mainnet-beta"].address);

    expect(usdt?.clusters).toEqual(["mainnet-beta"]);
  });

  it("agrees with the catalogue about which clusters a mint is valid on", () => {
    // The recurring-payment guard rejects a mainnet mint while the API points
    // at devnet by reading `clusters`, so it has to match the catalogue exactly.
    for (const [address, entry] of WELL_KNOWN_TOKEN_BY_MINT) {
      for (const cluster of CLUSTERS) {
        const declared = Object.values(WELL_KNOWN_TOKENS).some(
          (token: WellKnownToken) => token.mints[cluster]?.address === address
        );

        expect(entry.clusters.includes(cluster), `${address} on ${cluster}`).toBe(declared);
      }
    }
  });
});

describe("wellKnownMint and wellKnownDecimals", () => {
  it("resolves a token deployed on both clusters", () => {
    expect(wellKnownMint("SOL", "devnet")).toBe(SOL_MINT);
    expect(wellKnownDecimals("SOL", "mainnet-beta")).toBe(9);
  });

  it("returns undefined rather than another cluster's value when undeployed", () => {
    // Falling back to mainnet would hand a devnet caller a mint that does not
    // exist there, and for USDS it would scale amounts by the wrong power.
    expect(wellKnownMint("USDS", "devnet")).toBeUndefined();
    expect(wellKnownDecimals("USDS", "devnet")).toBeUndefined();
    expect(wellKnownDecimals("USDS", "mainnet-beta")).toBe(6);
  });
});
