import app from "@/index";
import { hashString } from "@/lib/hash";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/d1";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_PROJECT_ID = "prj_rpc_relay";
const TEST_API_KEY_ID = "key_rpc_relay";
const TEST_API_KEY_PREFIX = "sk_test_rpc";
const TEST_API_KEY_RAW = "sk_test_rpc_relay_key";

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
    const db = (env as { DB: D1Database }).DB;
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
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'free', 'active')"
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

    (env as { SOLANA_RPC_DEFAULT_PROVIDER?: string }).SOLANA_RPC_DEFAULT_PROVIDER = undefined;
    (env as { SOLANA_RPC_URL?: string }).SOLANA_RPC_URL = undefined;
    (env as { SOLANA_RPC_TRITON_URL?: string }).SOLANA_RPC_TRITON_URL = undefined;
    (env as { SOLANA_RPC_TRITON_API_KEY?: string }).SOLANA_RPC_TRITON_API_KEY = undefined;
    (env as { SOLANA_RPC_HELIUS_URL?: string }).SOLANA_RPC_HELIUS_URL = undefined;
    (env as { SOLANA_RPC_HELIUS_API_KEY?: string }).SOLANA_RPC_HELIUS_API_KEY = undefined;
    (env as { SOLANA_RPC_ALCHEMY_URL?: string }).SOLANA_RPC_ALCHEMY_URL = undefined;
    (env as { SOLANA_RPC_ALCHEMY_API_KEY?: string }).SOLANA_RPC_ALCHEMY_API_KEY = undefined;
  });

  it("uses project-selected managed provider when configured", async () => {
    const db = (env as { DB: D1Database }).DB;
    await db
      .prepare("UPDATE projects SET settings = ? WHERE id = ?")
      .bind(JSON.stringify({ rpcProvider: "helius" }), TEST_PROJECT_ID)
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
    expect(body.data.selected.selectionMode).toBe("project_provider");
    expect(String(body.data.selected.endpoint)).toContain("rpc.helius.test");
  });

  it("round-robins providers when project has no explicit provider setting", async () => {
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

  it("tracks transaction telemetry and origins per provider", async () => {
    const db = (env as { DB: D1Database }).DB;
    await db
      .prepare("UPDATE projects SET settings = ? WHERE id = ?")
      .bind(JSON.stringify({ rpcProvider: "triton" }), TEST_PROJECT_ID)
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
      "/v1/rpc/relay",
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
