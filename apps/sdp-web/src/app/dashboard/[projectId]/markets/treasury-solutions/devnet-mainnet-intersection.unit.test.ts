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

function mainnetStrategy(overrides: Partial<EarnStrategy>): EarnStrategy {
  return strategy({
    id: "earn_strategy_mainnet_test",
    hostCluster: "mainnet-beta",
    fundable: false,
    ...overrides,
  });
}

// The API-visible mainnet shelf the Sandbox page renders above its devnet
// rows: the mapped counterparts exist here, the vaults our shelf never lists
// (RockawayX) do not.
const MAINNET_SHELF = [
  mainnetStrategy({ id: "m1", name: "Steakhouse USDC" }),
  mainnetStrategy({ id: "m2", name: "Allez USDC" }),
  mainnetStrategy({ id: "m3", name: "Gauntlet Frontier" }),
  mainnetStrategy({ id: "m4", name: "Kamino JLP Vault" }),
];

describe("filterSandboxDevnetStrategies", () => {
  it("passes an unavailable shelf through unchanged", () => {
    // The merge reads undefined as "this shelf's read has not landed"; the
    // filter must not reinterpret that as an empty shelf.
    expect(filterSandboxDevnetStrategies(undefined, MAINNET_SHELF)).toBeUndefined();
  });

  it("keeps the devnet strategies whose mapped mainnet counterpart is offered", () => {
    const matched = ["Steakhouse USDC", "Allez USDC", "Gauntlet Frontier USDC"].map((name) =>
      strategy({ id: `earn_strategy_${name}`, name })
    );
    const kept = filterSandboxDevnetStrategies(matched, MAINNET_SHELF);
    if (!kept) throw new Error("Expected a rendered shelf for a rendered shelf's rows");

    expect(kept.map((entry) => entry.name)).toEqual([
      "Steakhouse USDC",
      "Allez USDC",
      "Gauntlet Frontier USDC",
    ]);
  });

  it("hides a mapped devnet strategy the mainnet shelf does not offer", () => {
    // RockawayX: the counterpart is real on-chain, but the API-visible
    // mainnet shelf never lists it, so the Sandbox shelf must not advertise
    // it either. The recorded pair alone is not proof.
    const rockaway = [strategy({ id: "a", name: "RockawayX RWA USDC" })];

    expect(filterSandboxDevnetStrategies(rockaway, MAINNET_SHELF)).toEqual([]);
  });

  it("hides a devnet strategy whose counterpart is offered by another provider", () => {
    // An unrelated provider reusing a mapped Kamino name must not ride the
    // Kamino mapping: the mainnet shelf has to offer the mapped name from the
    // SAME provider.
    const impostor = [strategy({ id: "a", provider: "ground", name: "Steakhouse USDC" })];
    const groundShelf = [
      mainnetStrategy({ id: "m1", provider: "ground", name: "Janus Henderson JAAA (USDC)" }),
    ];

    expect(filterSandboxDevnetStrategies(impostor, groundShelf)).toEqual([]);
    // The same name from the provider the mapping belongs to still passes.
    expect(filterSandboxDevnetStrategies(impostor, MAINNET_SHELF)).toEqual([]);
    const groundCounterpart = [
      mainnetStrategy({ id: "m1", provider: "ground", name: "Steakhouse USDC" }),
    ];
    expect(filterSandboxDevnetStrategies(impostor, groundCounterpart)).toEqual([impostor[0]]);
  });

  it("matches names case- and whitespace-insensitively on both shelves", () => {
    // Vault names are provider free text; spacing and case drift on either
    // shelf must not silently drop a row whose counterpart SDP has already
    // decided exists.
    const drifted = [
      strategy({ id: "a", name: " steakhouse  USDC " }),
      mainnetStrategy({ id: "m1", name: "  STEAKHOUSE   usdc " }),
    ];
    const kept = filterSandboxDevnetStrategies([drifted[0]], [drifted[1]]);
    if (!kept) throw new Error("Expected a rendered shelf for a rendered shelf's rows");

    expect(kept).toHaveLength(1);
  });

  it("keeps table-mapped devnet strategies while the mainnet catalogue has not landed", () => {
    // PRO-1961: a mainnet shelf that is loading or failed reads as undefined,
    // and the devnet rows must survive that outage. The recorded pair stands
    // alone until the catalogue can confirm or refute it — including
    // RockawayX, which the loaded shelf vetoes above.
    const devnet = [
      strategy({ id: "a", name: "Steakhouse USDC" }),
      strategy({ id: "b", name: "RockawayX RWA USDC" }),
      strategy({ id: "c", name: "Kamino Vault USDC" }),
    ];

    expect(filterSandboxDevnetStrategies(devnet, undefined)).toEqual([devnet[0], devnet[1]]);
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

    expect(filterSandboxDevnetStrategies(unmatched, undefined)).toEqual([]);
    expect(filterSandboxDevnetStrategies(unmatched, MAINNET_SHELF)).toEqual([]);
  });

  it("keeps every Veda strategy regardless of name, Veda being devnet-only", () => {
    const veda = [
      strategy({ id: "a", provider: "veda", name: "Veda USDC vault #0" }),
      strategy({ id: "b", provider: "veda", name: "Veda Treasury Fund" }),
    ];

    expect(filterSandboxDevnetStrategies(veda, undefined)).toEqual(veda);
    expect(filterSandboxDevnetStrategies(veda, MAINNET_SHELF)).toEqual(veda);
    // Even a Veda strategy whose name collides with a mapped Kamino entry.
    const collide = [strategy({ id: "c", provider: "veda", name: "Steakhouse USDC" })];
    expect(filterSandboxDevnetStrategies(collide, MAINNET_SHELF)).toEqual(collide);
  });

  it("applies the provider-checked name table to every non-Veda provider", () => {
    const mixed = [
      strategy({ id: "a", provider: "ground", name: "Janus Henderson JAAA (USDC)" }),
      strategy({ id: "b", provider: "ground", name: "Steakhouse USDC" }),
      strategy({ id: "c", provider: "kamino", name: "Steakhouse USDC" }),
    ];
    const kept = filterSandboxDevnetStrategies(mixed, MAINNET_SHELF);
    if (!kept) throw new Error("Expected a rendered shelf for a rendered shelf's rows");

    // Only the Kamino row's counterpart is on the mainnet shelf; the Ground
    // rows have no recorded pair, and Steakhouse is not Ground's to claim.
    expect(kept.map((entry) => entry.id)).toEqual(["c"]);
  });
});
