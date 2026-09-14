import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { GENESIS_HASH_BY_CLUSTER, wellKnownMint } from "@sdp/types";
import { ONDO_DEPLOYMENTS, ondoDeployment } from "@sdp/types/ondo-programs";
import { SdpEarnError } from "../../errors";
import { isStrategyWithinDeclaredSupport } from "../../support";
import { ONDO_USDY_DECIMALS, OndoEarnClient } from "./client";

/**
 * Canonical no-network harness (see src/fetch.test.ts): `globalThis.fetch` is
 * stubbed per test and restored in `afterEach`. Nothing here reaches an RPC.
 *
 * No API key in any context, deliberately: the catalogue is read entirely on
 * chain, so the only thing that can be misconfigured is the DEPLOYMENT — which
 * is what `PROVIDER_NOT_CONFIGURED` reports here.
 */

const client = new OndoEarnClient();

const MAINNET = ONDO_DEPLOYMENTS["mainnet-beta"];
assert.ok(MAINNET, "test premise: the mainnet deployment is filled in");
const USDY_MINT = MAINNET.usdyMint;
const USDC_MAINNET = wellKnownMint("USDC", "mainnet-beta") as string;
const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** An 82-byte SPL mint account with the given decimals at offset 44. */
function mintAccountData(decimals: number): string {
  const data = new Uint8Array(82);
  data[44] = decimals;
  data[45] = 1; // isInitialized
  return Buffer.from(data).toString("base64");
}

interface AccountFixture {
  owner?: string;
  data?: string;
  missing?: boolean;
}

/** Answers getGenesisHash and getAccountInfo the way a mainnet RPC would. */
function stubRpc(
  fixture: AccountFixture,
  genesis: string = GENESIS_HASH_BY_CLUSTER["mainnet-beta"]
) {
  mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
    if (body.method === "getGenesisHash") {
      return Response.json({ jsonrpc: "2.0", id: 1, result: genesis });
    }
    if (body.method === "getAccountInfo") {
      const value = fixture.missing
        ? null
        : {
            owner: fixture.owner ?? SPL_TOKEN_PROGRAM,
            data: [fixture.data ?? mintAccountData(ONDO_USDY_DECIMALS), "base64"],
          };
      return Response.json({ jsonrpc: "2.0", id: 1, result: { value } });
    }
    throw new Error(`unexpected RPC method ${body.method}`);
  });
}

afterEach(() => {
  mock.restoreAll();
});

describe("ondo deployment registry", () => {
  it("is mainnet-only", () => {
    assert.ok(ondoDeployment("mainnet-beta"));
    assert.equal(ondoDeployment("devnet"), null);
  });
});

describe("OndoEarnClient.listStrategies", () => {
  it("reports PROVIDER_NOT_CONFIGURED for sandbox (devnet has no deployment)", async () => {
    await assert.rejects(
      client.listStrategies({ env: {}, environment: "sandbox" }),
      (error: unknown) => error instanceof SdpEarnError && error.code === "PROVIDER_NOT_CONFIGURED"
    );
  });

  it("maps the USDY instrument into one rwa strategy row", async () => {
    stubRpc({});
    const snapshots = await client._listUsdyStrategy("https://rpc.test", "mainnet-beta", MAINNET);

    assert.equal(snapshots.length, 1);
    const snapshot = snapshots[0];
    assert.ok(snapshot);
    assert.equal(snapshot.providerReference, USDY_MINT);
    assert.equal(snapshot.shareMint, USDY_MINT);
    assert.deepEqual(snapshot.depositMints, [USDC_MAINNET]);
    assert.equal(snapshot.sourceKind, "rwa");
    assert.equal(snapshot.hostCluster, "mainnet-beta");
    assert.equal(snapshot.liquidityTerm, "instant");
    assert.equal(snapshot.redemptionDelayDays, undefined);
    assert.equal(snapshot.currentApy, undefined);
    assert.equal(snapshot.riskMetadata?.curator, "ondo");
    // The row must sit inside the envelope the sync validates against.
    assert.equal(isStrategyWithinDeclaredSupport(client.declaredSupport, snapshot), true);
  });

  it("refuses an endpoint that serves the wrong chain", async () => {
    stubRpc({}, GENESIS_HASH_BY_CLUSTER.devnet);
    await assert.rejects(
      client._listUsdyStrategy("https://rpc.test", "mainnet-beta", MAINNET),
      (error: unknown) => error instanceof SdpEarnError && error.code === "PROVIDER_NOT_CONFIGURED"
    );
  });

  it("fails the pass when the mint account is missing (never an empty shelf)", async () => {
    stubRpc({ missing: true });
    await assert.rejects(
      client._listUsdyStrategy("https://rpc.test", "mainnet-beta", MAINNET),
      (error: unknown) => error instanceof SdpEarnError && error.code === "INTERNAL_ERROR"
    );
  });

  it("fails the pass when the account is not an SPL token mint", async () => {
    stubRpc({ owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" });
    await assert.rejects(
      client._listUsdyStrategy("https://rpc.test", "mainnet-beta", MAINNET),
      (error: unknown) => error instanceof SdpEarnError && error.code === "INTERNAL_ERROR"
    );
  });

  it("fails the pass when the mint's decimals drift from what SDP expects", async () => {
    stubRpc({ data: mintAccountData(9) });
    await assert.rejects(
      client._listUsdyStrategy("https://rpc.test", "mainnet-beta", MAINNET),
      (error: unknown) => error instanceof SdpEarnError && error.code === "INTERNAL_ERROR"
    );
  });
});
