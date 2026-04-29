import type { OrganizationRpcProvider } from "@sdp/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { hashString } from "@/lib/hash";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";

const TEST_PROJECT_ID = "prj_rpc_relay";
const TEST_API_KEY_ID = "key_rpc_relay";
const TEST_API_KEY_PREFIX = "sk_test_rpc";
const TEST_API_KEY_RAW = "sk_test_rpc_relay_key";
type ManagedProvider = Exclude<OrganizationRpcProvider, "default">;

type MutableRpcEnv = {
  SOLANA_RPC_URL?: string;
  SOLANA_RPC_DEFAULT_PROVIDER?: string;
  SOLANA_RPC_TRITON_URL?: string;
  SOLANA_RPC_TRITON_API_KEY?: string;
  SOLANA_RPC_HELIUS_URL?: string;
  SOLANA_RPC_HELIUS_API_KEY?: string;
  SOLANA_RPC_ALCHEMY_URL?: string;
  SOLANA_RPC_ALCHEMY_API_KEY?: string;
  SOLANA_RPC_QUICKNODE_URL?: string;
  SOLANA_RPC_QUICKNODE_API_KEY?: string;
};

type ProviderRuntimeConfig = {
  provider: ManagedProvider;
  url: string;
  apiKey?: string;
};

const rpcEnv = env as MutableRpcEnv;

function normalizedValue(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function toHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function getProviderRuntimeConfig(provider: ManagedProvider): ProviderRuntimeConfig | null {
  if (provider === "triton") {
    const url = normalizedValue(rpcEnv.SOLANA_RPC_TRITON_URL ?? process.env.SOLANA_RPC_TRITON_URL);
    if (!url) {
      return null;
    }
    return {
      provider,
      url,
      apiKey: normalizedValue(
        rpcEnv.SOLANA_RPC_TRITON_API_KEY ??
          process.env.SOLANA_RPC_TRITON_API_KEY ??
          process.env.TRITON_API_KEY
      ),
    };
  }

  if (provider === "helius") {
    const url = normalizedValue(rpcEnv.SOLANA_RPC_HELIUS_URL ?? process.env.SOLANA_RPC_HELIUS_URL);
    if (!url) {
      return null;
    }
    return {
      provider,
      url,
      apiKey: normalizedValue(
        rpcEnv.SOLANA_RPC_HELIUS_API_KEY ??
          process.env.SOLANA_RPC_HELIUS_API_KEY ??
          process.env.HELIUS_API_KEY
      ),
    };
  }

  if (provider === "quicknode") {
    const url = normalizedValue(
      rpcEnv.SOLANA_RPC_QUICKNODE_URL ?? process.env.SOLANA_RPC_QUICKNODE_URL
    );
    if (!url) {
      return null;
    }
    return {
      provider,
      url,
      apiKey: normalizedValue(
        rpcEnv.SOLANA_RPC_QUICKNODE_API_KEY ??
          process.env.SOLANA_RPC_QUICKNODE_API_KEY ??
          process.env.QUICKNODE_API_KEY
      ),
    };
  }

  const url = normalizedValue(rpcEnv.SOLANA_RPC_ALCHEMY_URL ?? process.env.SOLANA_RPC_ALCHEMY_URL);
  if (!url) {
    return null;
  }
  return {
    provider,
    url,
    apiKey: normalizedValue(
      rpcEnv.SOLANA_RPC_ALCHEMY_API_KEY ??
        process.env.SOLANA_RPC_ALCHEMY_API_KEY ??
        process.env.ALCHEMY_API_KEY
    ),
  };
}

function applyProviderRuntimeConfigs(configs: ProviderRuntimeConfig[]): void {
  rpcEnv.SOLANA_RPC_TRITON_URL = undefined;
  rpcEnv.SOLANA_RPC_TRITON_API_KEY = undefined;
  rpcEnv.SOLANA_RPC_HELIUS_URL = undefined;
  rpcEnv.SOLANA_RPC_HELIUS_API_KEY = undefined;
  rpcEnv.SOLANA_RPC_ALCHEMY_URL = undefined;
  rpcEnv.SOLANA_RPC_ALCHEMY_API_KEY = undefined;
  rpcEnv.SOLANA_RPC_QUICKNODE_URL = undefined;
  rpcEnv.SOLANA_RPC_QUICKNODE_API_KEY = undefined;

  for (const config of configs) {
    if (config.provider === "triton") {
      rpcEnv.SOLANA_RPC_TRITON_URL = config.url;
      rpcEnv.SOLANA_RPC_TRITON_API_KEY = config.apiKey;
      continue;
    }
    if (config.provider === "helius") {
      rpcEnv.SOLANA_RPC_HELIUS_URL = config.url;
      rpcEnv.SOLANA_RPC_HELIUS_API_KEY = config.apiKey;
      continue;
    }
    if (config.provider === "quicknode") {
      rpcEnv.SOLANA_RPC_QUICKNODE_URL = config.url;
      rpcEnv.SOLANA_RPC_QUICKNODE_API_KEY = config.apiKey;
      continue;
    }
    rpcEnv.SOLANA_RPC_ALCHEMY_URL = config.url;
    rpcEnv.SOLANA_RPC_ALCHEMY_API_KEY = config.apiKey;
  }
}

const managedProviders: ManagedProvider[] = ["triton", "helius", "alchemy", "quicknode"];

const liveProviderConfigs = managedProviders
  .map((provider) => getProviderRuntimeConfig(provider))
  .filter((provider): provider is ProviderRuntimeConfig => provider !== null);

function hasLiveProviderConfig(provider: ManagedProvider): boolean {
  return liveProviderConfigs.some((config) => config.provider === provider);
}

function getRequiredLiveProviderConfigs(
  requiredProviders: readonly ManagedProvider[]
): ProviderRuntimeConfig[] {
  const missingProviders = requiredProviders.filter((provider) => !hasLiveProviderConfig(provider));

  if (missingProviders.length > 0) {
    throw new Error(
      `Missing live RPC provider config for: ${missingProviders.join(", ")}. Set SOLANA_RPC_TRITON_URL, SOLANA_RPC_HELIUS_URL, SOLANA_RPC_ALCHEMY_URL, and SOLANA_RPC_QUICKNODE_URL (plus API keys if needed).`
    );
  }

  return requiredProviders.map((provider) => {
    const config = liveProviderConfigs.find((item) => item.provider === provider);
    if (!config) {
      throw new Error(`Missing provider config for ${provider}`);
    }
    return config;
  });
}

async function clearKvNamespace(namespace: KVNamespace) {
  const listed = await namespace.list();
  for (const key of listed.keys) {
    await namespace.delete(key.name);
  }
}

describe("RPC Relay Routes", () => {
  let apiKeyHash: string;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
    apiKeyHash = await hashString(
      TEST_API_KEY_RAW,
      (env as { API_KEY_PEPPER?: string }).API_KEY_PEPPER
    );
  });

  afterAll(async () => {
    await clearTestDatabase(env as Parameters<typeof clearTestDatabase>[0]);
  });

  beforeEach(async () => {
    const db = getDb(env);
    const apiKeysKV = (env as { SDP_API_KEYS: KVNamespace }).SDP_API_KEYS;
    const rateLimitKV = (env as { SDP_RATE_LIMITS: KVNamespace }).SDP_RATE_LIMITS;
    const cacheKV = (env as { SDP_CACHE: KVNamespace }).SDP_CACHE;

    await clearKvNamespace(rateLimitKV);
    await clearKvNamespace(cacheKV);
    await clearKvNamespace(apiKeysKV);

    await db
      .prepare("DELETE FROM api_keys")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM project_members")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM projects")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM organization_members")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM organizations")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM users")
      .run()
      .catch(() => {});

    await db
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'enterprise', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();

    await db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(TEST_USER.id, TEST_USER.email)
      .run();

    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by, settings)
         VALUES (?, ?, 'RPC Project', 'rpc-project', 'sandbox', 'active', ?, NULL)`
      )
      .bind(TEST_PROJECT_ID, TEST_ORG.id, TEST_USER.id)
      .run();

    await db
      .prepare(
        `INSERT INTO api_keys
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, environment, status)
         VALUES (?, ?, ?, ?, 'RPC Relay Key', ?, ?, 'api_admin', '["*"]', 'sandbox', 'active')`
      )
      .bind(
        TEST_API_KEY_ID,
        TEST_ORG.id,
        TEST_PROJECT_ID,
        TEST_USER.id,
        TEST_API_KEY_PREFIX,
        apiKeyHash
      )
      .run();

    await apiKeysKV.put(
      `key:${apiKeyHash}`,
      JSON.stringify({
        id: TEST_API_KEY_ID,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        role: "api_admin",
        permissions: ["*"],
        environment: "sandbox",
        rateLimitTier: "standard",
        allowedIps: null,
        signingWalletId: null,
        status: "active",
        expiresAt: null,
      })
    );

    rpcEnv.SOLANA_RPC_DEFAULT_PROVIDER = undefined;
    rpcEnv.SOLANA_RPC_URL = undefined;
    rpcEnv.SOLANA_RPC_TRITON_URL = undefined;
    rpcEnv.SOLANA_RPC_TRITON_API_KEY = undefined;
    rpcEnv.SOLANA_RPC_HELIUS_URL = undefined;
    rpcEnv.SOLANA_RPC_HELIUS_API_KEY = undefined;
    rpcEnv.SOLANA_RPC_ALCHEMY_URL = undefined;
    rpcEnv.SOLANA_RPC_ALCHEMY_API_KEY = undefined;
    rpcEnv.SOLANA_RPC_QUICKNODE_URL = undefined;
    rpcEnv.SOLANA_RPC_QUICKNODE_API_KEY = undefined;
  });

  it("uses organization-selected managed provider when configured", async () => {
    const db = getDb(env);
    await db
      .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
      .bind(JSON.stringify({ rpcProvider: "helius" }), TEST_ORG.id)
      .run();

    (env as { SOLANA_RPC_TRITON_URL?: string }).SOLANA_RPC_TRITON_URL = "https://rpc.triton.test";
    (env as { SOLANA_RPC_TRITON_API_KEY?: string }).SOLANA_RPC_TRITON_API_KEY = "triton_key";
    (env as { SOLANA_RPC_HELIUS_URL?: string }).SOLANA_RPC_HELIUS_URL = "https://rpc.helius.test/";
    (env as { SOLANA_RPC_HELIUS_API_KEY?: string }).SOLANA_RPC_HELIUS_API_KEY = "helius_key";

    const response = await app.request(
      "/v1/rpc/providers",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY_RAW}`,
        },
      },
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.selected.providerId).toBe("helius");
    expect(body.data.selected.selectionMode).toBe("organization_provider");
    expect(String(body.data.selected.endpoint)).toContain("rpc.helius.test");
  });

  it("supports quicknode as an organization-selected managed provider", async () => {
    const db = getDb(env);
    await db
      .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
      .bind(JSON.stringify({ rpcProvider: "quicknode" }), TEST_ORG.id)
      .run();

    rpcEnv.SOLANA_RPC_QUICKNODE_URL = "https://rpc.quicknode.test/?api-key={API_KEY}";
    rpcEnv.SOLANA_RPC_QUICKNODE_API_KEY = "quicknode_key";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { solanaCore: "2.0.0" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const relayResponse = await app.request(
      "/v1/rpc/proxy",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY_RAW}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getVersion",
          params: [],
        }),
      },
      env
    );

    fetchSpy.mockRestore();

    expect(relayResponse.status).toBe(200);

    const body = await relayResponse.json();
    expect(body.data.provider.id).toBe("quicknode");
    expect(body.data.provider.selectionMode).toBe("organization_provider");
    expect(String(body.data.provider.endpoint)).toContain("rpc.quicknode.test");
    expect(String(body.data.provider.endpoint)).toContain("api-key=***");
  });

  for (const provider of managedProviders) {
    const itForProvider = it.runIf(provider !== "triton" && hasLiveProviderConfig(provider));

    itForProvider(
      `connectivity check: proxies through ${provider} when org rpcProvider is set`,
      async () => {
        const [selectedProviderConfig] = getRequiredLiveProviderConfigs([provider]);
        const db = getDb(env);
        await db
          .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
          .bind(JSON.stringify({ rpcProvider: provider }), TEST_ORG.id)
          .run();

        applyProviderRuntimeConfigs(liveProviderConfigs);

        const relayResponse = await app.request(
          "/v1/rpc/proxy",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${TEST_API_KEY_RAW}`,
              Origin: "https://dashboard.example.com",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "getVersion",
              params: [],
            }),
          },
          env
        );

        expect(relayResponse.status).toBe(200);
        const body = await relayResponse.json();
        expect(body.data.provider.id).toBe(provider);
        expect(body.data.provider.selectionMode).toBe("organization_provider");
        expect(body.data.upstream.status).toBeGreaterThan(0);
        expect(typeof body.data.upstream.ok).toBe("boolean");
        expect(String(body.data.provider.endpoint)).toContain(toHost(selectedProviderConfig.url));
      }
    );
  }

  const itWithSwitchProviders = it.runIf(
    hasLiveProviderConfig("helius") && hasLiveProviderConfig("alchemy")
  );

  itWithSwitchProviders(
    "switches relay endpoint after organization rpcProvider is changed",
    async () => {
      const [initialProvider, updatedProvider] = getRequiredLiveProviderConfigs([
        "helius",
        "alchemy",
      ]);

      const db = getDb(env);
      await db
        .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
        .bind(JSON.stringify({ rpcProvider: initialProvider.provider }), TEST_ORG.id)
        .run();

      applyProviderRuntimeConfigs(liveProviderConfigs);

      const firstRelay = await app.request(
        "/v1/rpc/proxy",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY_RAW}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getVersion",
            params: [],
          }),
        },
        env
      );

      const orgUpdate = await app.request(
        `/v1/organizations/${TEST_ORG.id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY_RAW}`,
          },
          body: JSON.stringify({
            settings: { rpcProvider: updatedProvider.provider },
          }),
        },
        env
      );

      const secondRelay = await app.request(
        "/v1/rpc/proxy",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY_RAW}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "getVersion",
            params: [],
          }),
        },
        env
      );

      expect(firstRelay.status).toBe(200);
      expect(orgUpdate.status).toBe(200);
      expect(secondRelay.status).toBe(200);

      const firstBody = await firstRelay.json();
      const secondBody = await secondRelay.json();

      expect(firstBody.data.provider.id).toBe(initialProvider.provider);
      expect(secondBody.data.provider.id).toBe(updatedProvider.provider);
      expect(firstBody.data.upstream.status).toBeGreaterThan(0);
      expect(secondBody.data.upstream.status).toBeGreaterThan(0);
      expect(String(firstBody.data.provider.endpoint)).toContain(toHost(initialProvider.url));
      expect(String(secondBody.data.provider.endpoint)).toContain(toHost(updatedProvider.url));
    }
  );

  it("round-robins providers when org has no explicit provider setting", async () => {
    (env as { SOLANA_RPC_TRITON_URL?: string }).SOLANA_RPC_TRITON_URL = "https://rpc.triton.test";
    (env as { SOLANA_RPC_HELIUS_URL?: string }).SOLANA_RPC_HELIUS_URL = "https://rpc.helius.test";

    const first = await app.request(
      "/v1/rpc/providers",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY_RAW}`,
        },
      },
      env
    );
    const second = await app.request(
      "/v1/rpc/providers",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY_RAW}`,
        },
      },
      env
    );

    const firstBody = await first.json();
    const secondBody = await second.json();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(firstBody.data.selected.providerId).toBe("triton");
    expect(secondBody.data.selected.providerId).toBe("helius");
  });

  it("round-robins faucet airdrops and falls back after provider rate limits", async () => {
    const db = getDb(env);
    const cacheKV = (env as { SDP_CACHE: KVNamespace }).SDP_CACHE;
    await db
      .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
      .bind(JSON.stringify({ rpcProvider: "triton" }), TEST_ORG.id)
      .run();
    await cacheKV.put("rpc:relay:round-robin-cursor", "1");

    rpcEnv.SOLANA_RPC_TRITON_URL = "https://rpc.triton.test";
    rpcEnv.SOLANA_RPC_HELIUS_URL = "https://rpc.helius.test";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("rpc.helius.test")) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "faucet-test",
            error: { code: -32429, message: "Too many airdrop requests" },
          }),
          {
            status: 429,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: "faucet-test", result: "triton_airdrop_sig" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    });

    try {
      const relayResponse = await app.request(
        "/v1/rpc/proxy",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY_RAW}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "faucet-test",
            method: "requestAirdrop",
            params: ["6bh8QhvDDd4rWRXggYpYwwCCkdaqSpkBg77vK39Tvujg", 1],
          }),
        },
        env
      );

      expect(relayResponse.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(String(fetchSpy.mock.calls[0][0])).toContain("rpc.helius.test");
      expect(String(fetchSpy.mock.calls[1][0])).toContain("rpc.triton.test");

      const body = await relayResponse.json();
      expect(body.data.provider.id).toBe("triton");
      expect(body.data.provider.selectionMode).toBe("round_robin_default");
      expect(body.data.response.result).toBe("triton_airdrop_sig");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("tracks transaction telemetry and origins per provider", async () => {
    const db = getDb(env);
    await db
      .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
      .bind(JSON.stringify({ rpcProvider: "triton" }), TEST_ORG.id)
      .run();

    (env as { SOLANA_RPC_TRITON_URL?: string }).SOLANA_RPC_TRITON_URL = "https://rpc.triton.test";
    (env as { SOLANA_RPC_TRITON_API_KEY?: string }).SOLANA_RPC_TRITON_API_KEY = "triton_key";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "tx_sig" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const relayResponse = await app.request(
      "/v1/rpc/proxy",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY_RAW}`,
          Origin: "https://wallet.example.com",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "sendTransaction",
          params: ["AQID", { skipPreflight: true }],
        }),
      },
      env
    );

    const providersResponse = await app.request(
      "/v1/rpc/providers",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY_RAW}`,
        },
      },
      env
    );

    fetchSpy.mockRestore();

    expect(relayResponse.status).toBe(200);
    expect(providersResponse.status).toBe(200);

    const providersBody = await providersResponse.json();
    const tritonProvider = providersBody.data.providers.find(
      (provider: { id: string }) => provider.id === "triton"
    );

    expect(tritonProvider).toBeDefined();
    expect(tritonProvider.stats.requestsTotal).toBe(1);
    expect(tritonProvider.stats.transactionRequests).toBe(1);
    expect(tritonProvider.stats.errorsTotal).toBe(0);
    expect(tritonProvider.stats.lastMethod).toBe("sendTransaction");
    expect(tritonProvider.stats.origins["https://wallet.example.com"]).toBe(1);
  });
});
