import { runInClusterScope } from "@sdp/rpc/scope";
import { describe, expect, it } from "vitest";
import { installClusterRpcStub } from "@/test/helpers/cluster-rpc";
import { syntheticAddress } from "@/test/helpers/parsed-transactions";
import { requestDevnetFaucetAirdrop } from "./devnet-faucet";

describe("requestDevnetFaucetAirdrop", () => {
  const rpc = installClusterRpcStub();

  it("refuses a production scope before any RPC call", async () => {
    await expect(
      runInClusterScope(
        { projectId: "prj_devnet_faucet_production", environment: "production" },
        () => requestDevnetFaucetAirdrop(syntheticAddress(1))
      )
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      statusCode: 403,
      details: { reason: "faucet_devnet_only", cluster: "mainnet-beta" },
    });
    expect(rpc.calls).toEqual([]);
  });
});
