import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { PLUME_CHAIN_ID, PLUME_VAULTS } from "@sdp/types/plume-programs";
import { PlumeEarnClient } from "./client";

/**
 * The live nOPAL listing shape (2026-11-02): a legacy V1 composer — the redeem
 * path — carries NO `chainId` and NO `cctpDepositEnabled`, and `targetApy` is
 * null when the vault has none. A schema that required V2 fields on every
 * entry rejected this body, so strategy sync failed against production.
 */
function vaultInfoBody(
  vault: (typeof PLUME_VAULTS)[number],
  overrides: { tvl?: number | null } = {}
) {
  return {
    slug: vault.slug,
    name: vault.name,
    decimals: vault.plumeShareDecimals,
    solana: {
      mintAddress: vault.shareMint,
      oftStoreAddress: vault.oftStore,
      decimals: vault.shareDecimals,
    },
    nestComposers: [
      { composerAddress: vault.redemptionComposer, complianceVersion: "v1" },
      {
        composerAddress: vault.mintComposer,
        chainId: PLUME_CHAIN_ID,
        complianceVersion: "v2",
        cctpDepositEnabled: true,
      },
    ],
    targetApy: null,
    tvl: overrides.tvl === undefined ? 1234.5 : overrides.tvl,
  };
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status });

const vault = PLUME_VAULTS[0];
const client = new PlumeEarnClient();
const ctx = { env: {}, environment: "production" } as Parameters<
  PlumeEarnClient["listStrategies"]
>[0];

afterEach(() => {
  mock.restoreAll();
});

describe("Plume strategy sync", () => {
  it("parses the live listing: legacy V1 composers and nullable metadata", async () => {
    mock.method(globalThis, "fetch", async () => jsonResponse(200, { data: vaultInfoBody(vault) }));

    const snapshots = await client.listStrategies(ctx);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].providerReference, vault.shareMint);
    assert.equal(snapshots[0].name, vault.name);
    // TVL rides along as a JSON number — catalogue ranking and Treasury read
    // `tvlUsd` as a number and reject strings.
    assert.equal(snapshots[0].riskMetadata?.tvlUsd, 1234.5);
  });
  it("omits a null TVL instead of stringifying it", async () => {
    const body = vaultInfoBody(vault, { tvl: null });
    mock.method(globalThis, "fetch", async () => jsonResponse(200, { data: body }));

    const snapshots = await client.listStrategies(ctx);
    assert.equal(snapshots.length, 1);
    assert.equal("tvlUsd" in (snapshots[0].riskMetadata ?? {}), false);
  });
  it("refuses a V2 composer whose chain metadata is missing", async () => {
    const body = vaultInfoBody(vault);
    (body.nestComposers[1] as Record<string, unknown>).chainId = undefined;
    mock.method(globalThis, "fetch", async () => jsonResponse(200, { data: body }));

    await assert.rejects(client.listStrategies(ctx), /differs from its approved deployment/);
  });
});
