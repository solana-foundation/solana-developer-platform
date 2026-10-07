import { resolveRoundRobinRpcTargets, resolveRpcTarget } from "@sdp/rpc/relay";
import { beforeEach, describe, expect, it } from "vitest";
import type { KVStore, KVStoreSet } from "@/runtime/kv";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { env, resetManagedRpcEnv } from "@/test/helpers/env";

const ROUND_ROBIN_CURSOR_KEY = "rpc:relay:round-robin-cursor";
const kv: KVStoreSet = createKVStoreSet(env);

async function clearKvStore(store: KVStore) {
  const listed = await store.list();
  for (const key of listed.keys) {
    await store.delete(key.name);
  }
}

async function resolveNextTarget() {
  return resolveRpcTarget({ env, cache: kv.cache });
}

describe("rpc-relay.service", () => {
  beforeEach(async () => {
    await clearKvStore(kv.cache);
    resetManagedRpcEnv();
  });

  it("resolves a query-string key into the endpoint and masks it in the label", async () => {
    env.SOLANA_RPC_QUICKNODE_URL = "https://rpc.quicknode.test/?api-key={API_KEY}";
    env.SOLANA_RPC_QUICKNODE_API_KEY = "qn_secret";

    const target = await resolveNextTarget();

    expect(target).toEqual({
      providerId: "quicknode",
      endpoint: "https://rpc.quicknode.test/?api-key=qn_secret",
      endpointLabel: "https://rpc.quicknode.test/?api-key=***",
    });
  });

  it("resolves validationcloud, substitutes the path-segment key, and redacts it in the label", async () => {
    env.SOLANA_RPC_VALIDATIONCLOUD_URL = "https://devnet.solana.validationcloud.io/v1/{API_KEY}";
    env.SOLANA_RPC_VALIDATIONCLOUD_API_KEY = "vc_secret";

    const target = await resolveNextTarget();

    expect(target.providerId).toBe("validationcloud");
    expect(target.endpoint).toContain("/v1/vc_secret");
    expect(target.endpointLabel).not.toContain("vc_secret");
    expect(target.endpointLabel).toContain("/v1/***");
  });

  it("masks overlapping provider keys without leaving remnants", async () => {
    env.SOLANA_RPC_VALIDATIONCLOUD_URL = "https://devnet.solana.validationcloud.io/v1/{API_KEY}";
    env.SOLANA_RPC_VALIDATIONCLOUD_API_KEY = "vc_secret_long_123";
    env.SOLANA_RPC_TRITON_API_KEY = "vc_secret";

    const target = await resolveNextTarget();

    expect(target.providerId).toBe("validationcloud");
    expect(target.endpointLabel).toContain("/v1/***");
    expect(target.endpointLabel).not.toContain("long_123");
  });

  it("redacts URL-encoded keys even when the endpoint URL is unparseable", async () => {
    env.SOLANA_RPC_VALIDATIONCLOUD_URL = "devnet.solana.validationcloud.io/v1/{API_KEY}";
    env.SOLANA_RPC_VALIDATIONCLOUD_API_KEY = "vc+secret/with=chars";

    const target = await resolveNextTarget();

    expect(target.providerId).toBe("validationcloud");
    expect(target.endpoint).toContain("/v1/vc%2Bsecret%2Fwith%3Dchars");
    expect(target.endpointLabel).toContain("/v1/***");
    expect(target.endpointLabel).not.toContain("vc+secret");
    expect(target.endpointLabel).not.toContain("vc%2Bsecret");
  });

  it("resolves Nodit with URL-only authentication and a redacted endpoint label", async () => {
    env.SOLANA_RPC_NODIT_URL = "https://solana-devnet.nodit.io/{API_KEY}";
    env.SOLANA_RPC_NODIT_API_KEY = "nodit+secret/with=chars";

    const target = await resolveNextTarget();

    expect(target.providerId).toBe("nodit");
    expect(target.endpoint).toBe("https://solana-devnet.nodit.io/nodit%2Bsecret%2Fwith%3Dchars");
    expect(target.endpointLabel).toContain("/***");
    expect(target.endpointLabel).not.toContain("nodit+secret");
    expect(target.endpointLabel).not.toContain("nodit%2Bsecret");
  });

  it("resolves a complete Nodit URL without a separate key like other providers", async () => {
    env.SOLANA_RPC_NODIT_URL = "https://rpc.nodit.test/rpc";

    const target = await resolveNextTarget();

    expect(target.providerId).toBe("nodit");
    expect(target.endpoint).toBe("https://rpc.nodit.test/rpc");
  });

  it("rotates through the managed pool in provider order with the default last", async () => {
    env.SOLANA_RPC_TRITON_URL = "https://rpc.triton.test";
    env.SOLANA_RPC_HELIUS_URL = "https://rpc.helius.test";
    env.SOLANA_RPC_ALCHEMY_URL = "https://rpc.alchemy.test";
    env.SOLANA_RPC_QUICKNODE_URL = "https://rpc.quicknode.test";
    env.SOLANA_RPC_VALIDATIONCLOUD_URL = "https://rpc.validationcloud.test";
    env.SOLANA_RPC_NODIT_URL = "https://rpc.nodit.test/{API_KEY}";
    env.SOLANA_RPC_NODIT_API_KEY = "nodit-key";
    env.SOLANA_RPC_URL = "https://rpc.default.test";

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

  it("starts the rotation at SOLANA_RPC_DEFAULT_PROVIDER", async () => {
    env.SOLANA_RPC_TRITON_URL = "https://rpc.triton.test";
    env.SOLANA_RPC_HELIUS_URL = "https://rpc.helius.test";
    env.SOLANA_RPC_QUICKNODE_URL = "https://rpc.quicknode.test";
    env.SOLANA_RPC_DEFAULT_PROVIDER = "quicknode";

    const target = await resolveNextTarget();

    expect(target.providerId).toBe("quicknode");
  });

  it("wraps back to the first provider after the last one", async () => {
    env.SOLANA_RPC_TRITON_URL = "https://rpc.triton.test";
    env.SOLANA_RPC_HELIUS_URL = "https://rpc.helius.test";

    const providerIds: string[] = [];
    for (let request = 0; request < 3; request += 1) {
      providerIds.push((await resolveNextTarget()).providerId);
    }

    expect(providerIds).toEqual(["triton", "helius", "triton"]);
    expect(await kv.cache.get(ROUND_ROBIN_CURSOR_KEY)).toBe("1");
  });

  it("never writes the cursor for a single provider", async () => {
    env.SOLANA_RPC_TRITON_URL = "https://rpc.triton.test";

    expect((await resolveNextTarget()).providerId).toBe("triton");
    expect((await resolveNextTarget()).providerId).toBe("triton");
    expect((await kv.cache.list()).keys).toEqual([]);
  });

  it.each(["not-a-number", "-3"])(
    "restarts the rotation at the first provider when the cursor reads %s",
    async (storedCursor) => {
      env.SOLANA_RPC_TRITON_URL = "https://rpc.triton.test";
      env.SOLANA_RPC_HELIUS_URL = "https://rpc.helius.test";
      await kv.cache.put(ROUND_ROBIN_CURSOR_KEY, storedCursor);

      const target = await resolveNextTarget();

      expect(target.providerId).toBe("triton");
      expect(await kv.cache.get(ROUND_ROBIN_CURSOR_KEY)).toBe("1");
    }
  );

  it("refuses to resolve a target when no managed provider is configured", async () => {
    await expect(resolveNextTarget()).rejects.toMatchObject({
      name: "SdpRpcError",
      code: "SOLANA_RPC_ERROR",
    });
    await expect(resolveRoundRobinRpcTargets({ env, cache: kv.cache })).rejects.toMatchObject({
      name: "SdpRpcError",
      code: "SOLANA_RPC_ERROR",
    });
  });

  it("lists every provider rotated to the selected one and advances the shared cursor", async () => {
    env.SOLANA_RPC_TRITON_URL = "https://rpc.triton.test";
    env.SOLANA_RPC_HELIUS_URL = "https://rpc.helius.test/?api-key={API_KEY}";
    env.SOLANA_RPC_HELIUS_API_KEY = "helius_secret";
    env.SOLANA_RPC_ALCHEMY_URL = "https://rpc.alchemy.test";
    await resolveNextTarget();

    const targets = await resolveRoundRobinRpcTargets({ env, cache: kv.cache });

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
});
