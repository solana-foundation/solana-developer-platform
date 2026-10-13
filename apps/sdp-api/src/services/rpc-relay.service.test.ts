import { resolveRoundRobinRpcTargets, resolveRpcTarget } from "@sdp/rpc/relay";
import { runInClusterScope } from "@sdp/rpc/scope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { env } from "@/test/helpers/env";
import { clearKVStores } from "@/test/mocks/kv";
import type { Env } from "@/types/env";

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

function resolveTargetIn(facts: ClusterScopeFacts, rpcEnv: Env) {
  return runInClusterScope(facts, () => resolveRpcTarget({ env: rpcEnv, cache: kv.cache }));
}

function resolveNextTarget() {
  return resolveTargetIn(SANDBOX_SCOPE, env);
}

describe("rpc-relay.service", () => {
  beforeEach(async () => {
    await clearKVStores(env);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("answers the configured endpoint and masks its query-string key in the label", async () => {
    vi.stubEnv(
      "SOLANA_RPC_QUICKNODE_DEVNET_API_KEY_URL",
      "https://rpc.quicknode.test/?api-key=qn_secret"
    );

    const target = await resolveNextTarget();

    expect(target).toEqual({
      providerId: "quicknode",
      endpoint: "https://rpc.quicknode.test/?api-key=qn_secret",
      endpointLabel: "https://rpc.quicknode.test/?api-key=***",
    });
  });

  it("masks overlapping provider keys without leaving remnants", async () => {
    vi.stubEnv(
      "SOLANA_RPC_VALIDATIONCLOUD_DEVNET_API_KEY_URL",
      "https://devnet.solana.validationcloud.io/v1/vc_secret_long_123"
    );

    const target = await resolveTargetIn(SANDBOX_SCOPE, {
      ...env,
      SOLANA_RPC_VALIDATIONCLOUD_API_KEY: "vc_secret_long_123",
      SOLANA_RPC_TRITON_API_KEY: "vc_secret",
    });

    expect(target.providerId).toBe("validationcloud");
    expect(target.endpointLabel).toContain("/v1/***");
    expect(target.endpointLabel).not.toContain("long_123");
  });

  it("redacts URL-encoded keys even when the endpoint URL is unparseable", async () => {
    vi.stubEnv(
      "SOLANA_RPC_VALIDATIONCLOUD_DEVNET_API_KEY_URL",
      "devnet.solana.validationcloud.io/v1/vc%2Bsecret%2Fwith%3Dchars"
    );

    const target = await resolveTargetIn(SANDBOX_SCOPE, {
      ...env,
      SOLANA_RPC_VALIDATIONCLOUD_API_KEY: "vc+secret/with=chars",
    });

    expect(target.providerId).toBe("validationcloud");
    expect(target.endpoint).toBe("devnet.solana.validationcloud.io/v1/vc%2Bsecret%2Fwith%3Dchars");
    expect(target.endpointLabel).toBe("devnet.solana.validationcloud.io/v1/***");
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
      runInClusterScope(SANDBOX_SCOPE, () => resolveRoundRobinRpcTargets({ env, cache: kv.cache }))
    ).rejects.toMatchObject({
      name: "SdpRpcError",
      code: "RPC_NOT_CONFIGURED",
    });
  });

  it("refuses to resolve a target outside a cluster scope", async () => {
    vi.stubEnv("SOLANA_RPC_TRITON_DEVNET_API_KEY_URL", "https://rpc.triton.test");

    await expect(resolveRpcTarget({ env, cache: kv.cache })).rejects.toMatchObject({
      name: "SdpRpcError",
      code: "CLUSTER_SCOPE_MISSING",
    });
  });

  it("lists every provider rotated to the selected one and advances the cluster's cursor", async () => {
    vi.stubEnv("SOLANA_RPC_TRITON_DEVNET_API_KEY_URL", "https://rpc.triton.test");
    vi.stubEnv(
      "SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL",
      "https://rpc.helius.test/?api-key=helius_secret"
    );
    vi.stubEnv("SOLANA_RPC_ALCHEMY_DEVNET_API_KEY_URL", "https://rpc.alchemy.test");
    await resolveNextTarget();

    const targets = await runInClusterScope(SANDBOX_SCOPE, () =>
      resolveRoundRobinRpcTargets({ env, cache: kv.cache })
    );

    expect(targets).toEqual([
      {
        providerId: "helius",
        endpoint: "https://rpc.helius.test/?api-key=helius_secret",
        endpointLabel: "https://rpc.helius.test/?api-key=***",
      },
      {
        providerId: "alchemy",
        endpoint: "https://rpc.alchemy.test",
        endpointLabel: "https://rpc.alchemy.test/",
      },
      {
        providerId: "triton",
        endpoint: "https://rpc.triton.test",
        endpointLabel: "https://rpc.triton.test/",
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
      endpoints.push((await resolveTargetIn(facts, env)).endpoint);
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
