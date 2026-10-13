import { resolveRoundRobinRpcTargets, resolveRpcTarget } from "@sdp/rpc/relay";
import { runInClusterScope } from "@sdp/rpc/scope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { env } from "@/test/helpers/env";
import { clearKVStores } from "@/test/mocks/kv";

type ClusterScopeFacts = Parameters<typeof runInClusterScope>[0];

const DEVNET_CURSOR_KEY = "rpc:relay:round-robin-cursor:devnet";
const MAINNET_CURSOR_KEY = "rpc:relay:round-robin-cursor:mainnet-beta";
const SANDBOX_SCOPE: ClusterScopeFacts = {
  projectId: "prj_rpc_relay_sandbox",
  environment: "sandbox",
};
const PRODUCTION_SCOPE: ClusterScopeFacts = {
  projectId: "prj_rpc_relay_production",
  environment: "production",
};
const kv = createKVStoreSet(env);

function resolveTargetIn(facts: ClusterScopeFacts) {
  return runInClusterScope(facts, () => resolveRpcTarget({ cache: kv.cache }));
}

function resolveNextTarget() {
  return resolveTargetIn(SANDBOX_SCOPE);
}

describe("rpc-relay.service", () => {
  beforeEach(async () => {
    await clearKVStores(env);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("labels an endpoint by protocol and host only, whatever key its URL carries", async () => {
    vi.stubEnv(
      "SOLANA_RPC_ALCHEMY_MAINNET_API_KEY_URL",
      "https://user:pass@solana-mainnet.example.test/v2/abcKEY123?api-key=xyz"
    );

    const target = await resolveTargetIn(PRODUCTION_SCOPE);

    expect(target).toEqual({
      cluster: "mainnet-beta",
      providerId: "alchemy",
      endpoint: "https://user:pass@solana-mainnet.example.test/v2/abcKEY123?api-key=xyz",
      endpointLabel: "https://solana-mainnet.example.test",
    });
  });

  it("rotates through the managed pool in provider order with the default last", async () => {
    vi.stubEnv("SOLANA_RPC_TRITON_DEVNET_API_KEY_URL", "https://rpc.triton.test");
    vi.stubEnv("SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL", "https://rpc.helius.test");
    vi.stubEnv("SOLANA_RPC_ALCHEMY_DEVNET_API_KEY_URL", "https://rpc.alchemy.test");
    vi.stubEnv("SOLANA_RPC_QUICKNODE_DEVNET_API_KEY_URL", "https://rpc.quicknode.test");
    vi.stubEnv("SOLANA_RPC_VALIDATIONCLOUD_DEVNET_API_KEY_URL", "https://rpc.validationcloud.test");
    vi.stubEnv("SOLANA_RPC_NODIT_DEVNET_API_KEY_URL", "https://rpc.nodit.test");
    vi.stubEnv("SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL", "https://rpc.default.test");

    const providerIds: string[] = [];
    for (let request = 0; request < 7; request += 1) {
      providerIds.push((await resolveNextTarget()).providerId);
    }

    expect(providerIds).toEqual([
      "triton",
      "helius",
      "alchemy",
      "quicknode",
      "validationcloud",
      "nodit",
      "default",
    ]);
  });

  it("wraps back to the first provider after the last one", async () => {
    vi.stubEnv("SOLANA_RPC_TRITON_DEVNET_API_KEY_URL", "https://rpc.triton.test");
    vi.stubEnv("SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL", "https://rpc.helius.test");

    const providerIds: string[] = [];
    for (let request = 0; request < 3; request += 1) {
      providerIds.push((await resolveNextTarget()).providerId);
    }

    expect(providerIds).toEqual(["triton", "helius", "triton"]);
    expect(await kv.cache.get(DEVNET_CURSOR_KEY)).toBe("1");
  });

  it("never writes the cursor for a single provider", async () => {
    vi.stubEnv("SOLANA_RPC_TRITON_DEVNET_API_KEY_URL", "https://rpc.triton.test");

    expect((await resolveNextTarget()).providerId).toBe("triton");
    expect((await resolveNextTarget()).providerId).toBe("triton");
    expect((await kv.cache.list()).keys).toEqual([]);
  });

  it.each(["not-a-number", "-3"])(
    "restarts the rotation at the first provider when the cursor reads %s",
    async (storedCursor) => {
      vi.stubEnv("SOLANA_RPC_TRITON_DEVNET_API_KEY_URL", "https://rpc.triton.test");
      vi.stubEnv("SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL", "https://rpc.helius.test");
      await kv.cache.put(DEVNET_CURSOR_KEY, storedCursor);

      const target = await resolveNextTarget();

      expect(target.providerId).toBe("triton");
      expect(await kv.cache.get(DEVNET_CURSOR_KEY)).toBe("1");
    }
  );

  it("refuses to resolve a target when the scope's cluster has no endpoint configured", async () => {
    vi.stubEnv("SOLANA_RPC_TRITON_MAINNET_API_KEY_URL", "https://rpc.triton.test");

    await expect(resolveNextTarget()).rejects.toMatchObject({
      name: "SdpRpcError",
      code: "RPC_NOT_CONFIGURED",
    });
    await expect(
      runInClusterScope(SANDBOX_SCOPE, () => resolveRoundRobinRpcTargets({ cache: kv.cache }))
    ).rejects.toMatchObject({
      name: "SdpRpcError",
      code: "RPC_NOT_CONFIGURED",
    });
  });

  it("refuses to resolve a target outside a cluster scope", async () => {
    vi.stubEnv("SOLANA_RPC_TRITON_DEVNET_API_KEY_URL", "https://rpc.triton.test");

    await expect(resolveRpcTarget({ cache: kv.cache })).rejects.toMatchObject({
      name: "SdpRpcError",
      code: "CLUSTER_SCOPE_MISSING",
    });
  });

  it("lists every provider rotated to the selected one and advances the cluster's cursor", async () => {
    vi.stubEnv("SOLANA_RPC_TRITON_DEVNET_API_KEY_URL", "https://rpc.triton.test");
    vi.stubEnv("SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL", "https://rpc.helius.test/?api-key=xyz");
    vi.stubEnv("SOLANA_RPC_ALCHEMY_DEVNET_API_KEY_URL", "https://rpc.alchemy.test");
    await resolveNextTarget();

    const targets = await runInClusterScope(SANDBOX_SCOPE, () =>
      resolveRoundRobinRpcTargets({ cache: kv.cache })
    );

    expect(targets).toEqual([
      {
        cluster: "devnet",
        providerId: "helius",
        endpoint: "https://rpc.helius.test/?api-key=xyz",
        endpointLabel: "https://rpc.helius.test",
      },
      {
        cluster: "devnet",
        providerId: "alchemy",
        endpoint: "https://rpc.alchemy.test",
        endpointLabel: "https://rpc.alchemy.test",
      },
      {
        cluster: "devnet",
        providerId: "triton",
        endpoint: "https://rpc.triton.test",
        endpointLabel: "https://rpc.triton.test",
      },
    ]);
    expect((await resolveNextTarget()).providerId).toBe("alchemy");
  });

  it("serves a Production scope from the mainnet-beta pool, each cluster on its own cursor", async () => {
    vi.stubEnv("SOLANA_RPC_TRITON_DEVNET_API_KEY_URL", "https://devnet.triton.test");
    vi.stubEnv("SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL", "https://devnet.default.test");
    vi.stubEnv("SOLANA_RPC_TRITON_MAINNET_API_KEY_URL", "https://mainnet.triton.test");
    vi.stubEnv("SOLANA_RPC_DEFAULT_MAINNET_API_KEY_URL", "https://mainnet.default.test");

    const endpoints: string[] = [];
    for (const facts of [
      SANDBOX_SCOPE,
      PRODUCTION_SCOPE,
      SANDBOX_SCOPE,
      PRODUCTION_SCOPE,
      PRODUCTION_SCOPE,
    ]) {
      endpoints.push((await resolveTargetIn(facts)).endpoint);
    }

    expect(endpoints).toEqual([
      "https://devnet.triton.test",
      "https://mainnet.triton.test",
      "https://devnet.default.test",
      "https://mainnet.default.test",
      "https://mainnet.triton.test",
    ]);
    expect(await kv.cache.get(DEVNET_CURSOR_KEY)).toBe("0");
    expect(await kv.cache.get(MAINNET_CURSOR_KEY)).toBe("1");
  });
});
