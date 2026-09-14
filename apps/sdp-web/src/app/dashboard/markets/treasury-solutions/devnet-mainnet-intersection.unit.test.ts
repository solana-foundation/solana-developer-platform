import type { EarnStrategy } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { filterSandboxDevnetStrategies } from "./devnet-mainnet-intersection";

function strategy(overrides: Partial<EarnStrategy>): EarnStrategy {
  return {
    id: "earn_strategy_test",
    provider: "kamino",
    providerReference: "Kvault11111111111111111111111111111111111",
    name: "Steakhouse USDC",
    sourceKind: "defi",
    depositMints: ["USDC-mint"],
    apyType: "variable",
    currentApy: "0.062",
    liquidityTerm: "instant",
    status: "active",
    depositSlippage: null,
    withdrawalSlippage: null,
    hostCluster: "devnet",
    fundable: true,
    feeSponsored: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("filterSandboxDevnetStrategies", () => {
  it("passes an unavailable shelf through unchanged", () => {
    // The merge reads undefined as "this shelf's read has not landed"; the
    // filter must not reinterpret that as an empty shelf.
    expect(filterSandboxDevnetStrategies(undefined)).toBeUndefined();
  });

  it("keeps the devnet strategies the hardcoded table matches to a mainnet counterpart", () => {
    const matched = [
      "Steakhouse USDC",
      "Allez USDC",
      "Gauntlet Frontier USDC",
      "RockawayX RWA USDC",
    ].map((name) => strategy({ id: `earn_strategy_${name}`, name }));
    const kept = filterSandboxDevnetStrategies(matched);
    if (!kept) throw new Error("Expected a rendered shelf for a rendered shelf's rows");

    expect(kept.map((entry) => entry.name)).toEqual([
      "Steakhouse USDC",
      "Allez USDC",
      "Gauntlet Frontier USDC",
      "RockawayX RWA USDC",
    ]);
  });

  it("matches a provider name case- and whitespace-insensitively", () => {
    // Vault names are provider free text; spacing and case drift must not
    // silently drop a row whose counterpart SDP has already decided exists.
    const drifted = [
      strategy({ id: "a", name: " steakhouse  USDC " }),
      strategy({ id: "b", name: "rockawayx rwa usdc" }),
    ];
    const kept = filterSandboxDevnetStrategies(drifted);
    if (!kept) throw new Error("Expected a rendered shelf for a rendered shelf's rows");

    expect(kept).toHaveLength(2);
  });

  it("hides devnet strategies with no mainnet counterpart", () => {
    // The real devnet-only Kamino vaults, plus an arbitrary new one: absent
    // from the table means hidden, so a fresh devnet vault never reaches the
    // shelf until its mainnet counterpart is decided and recorded.
    const unmatched = [
      strategy({ id: "a", name: "Kamino Vault USDC" }),
      strategy({ id: "b", name: "PyUSDC" }),
      strategy({ id: "c", name: "Brand New Devnet Vault" }),
    ];

    expect(filterSandboxDevnetStrategies(unmatched)).toEqual([]);
  });

  it("keeps every Veda strategy regardless of name, Veda being devnet-only", () => {
    const veda = [
      strategy({ id: "a", provider: "veda", name: "Veda USDC vault #0" }),
      strategy({ id: "b", provider: "veda", name: "Veda Treasury Fund" }),
    ];

    expect(filterSandboxDevnetStrategies(veda)).toEqual(veda);
  });

  it("applies the name table to every non-Veda provider, not just Kamino", () => {
    const mixed = [
      strategy({ id: "a", provider: "ground", name: "Janus Henderson JAAA (USDC)" }),
      strategy({ id: "b", provider: "ground", name: "Steakhouse USDC" }),
    ];
    const kept = filterSandboxDevnetStrategies(mixed);
    if (!kept) throw new Error("Expected a rendered shelf for a rendered shelf's rows");

    expect(kept.map((entry) => entry.id)).toEqual(["b"]);
  });
});
