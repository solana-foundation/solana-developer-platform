import { hashString } from "@sdp/payments/hash";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import type { KVStore } from "@/runtime/kv";
import { createKVStoreSet } from "@/runtime/kv-redis";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import { env, resetManagedRpcEnv } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { seedRateLimit } from "@/test/mocks/kv";

const TEST_PROJECT_ID = "prj_rpc_relay";
const TEST_API_KEY_ID = "key_rpc_relay";
const TEST_API_KEY_PREFIX = "sk_test_rpc";
const TEST_API_KEY_RAW = "sk_test_rpc_relay_key";
const OWNED_FAUCET_ADDRESS = "6bh8QhvDDd4rWRXggYpYwwCCkdaqSpkBg77vK39Tvujg";

async function clearKvStore(store: KVStore) {
  const listed = await store.list();
  for (const key of listed.keys) {
    await store.delete(key.name);
  }
}

/**
 * Register `publicKey` as a custody wallet of one of `organizationId`'s projects,
 * the ownership the faucet guard proves airdrop destinations against. Rows
 * cascade away with the project and organization deletes in beforeEach.
 * @param organizationId - Organization that owns the project.
 * @param projectId - Project whose config owns the wallet.
 * @param publicKey - The wallet address.
 * @param suffix - Distinguishes the seeded row ids.
 * @param walletStatus - The wallet row status.
 * @returns Resolves once the config and wallet are written.
 */
async function seedCustodyWalletForProject(
  organizationId: string,
  projectId: string,
  publicKey: string,
  suffix: string,
  walletStatus: CustodyWallet["status"]
): Promise<void> {
  await seedTestCustodyRows(env, {
    configs: [
      {
        id: `cfg_faucet_${suffix}`,
        organizationId,
        projectId,
        provider: "local",
        configEncrypted: "test-config",
        status: "active",
      },
    ],
    wallets: [
      {
        id: `cw_faucet_${suffix}`,
        owner: { kind: "config", custodyConfigId: `cfg_faucet_${suffix}` },
        walletId: `wallet_faucet_${suffix}`,
        publicKey,
        label: "Faucet Wallet",
        purpose: "transfer",
        status: walletStatus,
      },
    ],
  });
}

function jsonRpcResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function relayProxy(payload: unknown): Promise<Response> {
  return app.request(
    "/v1/rpc/proxy",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_API_KEY_RAW}`,
      },
      body: JSON.stringify(payload),
    },
    env
  );
}

describe("RPC Relay Routes", () => {
  let apiKeyHash: string;

  beforeAll(async () => {
    await seedTestDatabase(env);
    apiKeyHash = await hashString(TEST_API_KEY_RAW, env.API_KEY_PEPPER);
  });

  afterAll(async () => {
    await seedTestDatabase(env);
  });

  beforeEach(async () => {
    const db = getDb(env);
    const kv = createKVStoreSet(env);

    await clearKvStore(kv.rateLimits);
    await clearKvStore(kv.cache);
    await clearKvStore(kv.apiKeys);

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

    await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [],
      ids: { sandbox: TEST_PROJECT_ID, production: `${TEST_PROJECT_ID}_production` },
    });

    await db
      .prepare(
        `INSERT INTO api_keys
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, 'RPC Relay Key', ?, ?, 'api_admin', '["*"]', 'active')`
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

    await kv.apiKeys.put(
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
    resetManagedRpcEnv();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("relays through plain fetch with a 30s bound and answers the masked provider", async () => {
    env.SOLANA_RPC_QUICKNODE_URL = "https://rpc.quicknode.test/?api-key={API_KEY}";
    env.SOLANA_RPC_QUICKNODE_API_KEY = "quicknode_key";
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonRpcResponse({ jsonrpc: "2.0", id: 1, result: { solanaCore: "2.0.0" } }, 200)
      );

    const response = await relayProxy({ jsonrpc: "2.0", id: 1, method: "getVersion", params: [] });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.provider).toEqual({
      id: "quicknode",
      endpoint: "https://rpc.quicknode.test/?api-key=***",
    });
    expect(body.data.response.result).toEqual({ solanaCore: "2.0.0" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://rpc.quicknode.test/?api-key=quicknode_key",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) })
    );
    expect(timeout).toHaveBeenCalledWith(30_000);
  });

  it("alternates two managed providers across requests", async () => {
    env.SOLANA_RPC_TRITON_URL = "https://rpc.triton.test";
    env.SOLANA_RPC_HELIUS_URL = "https://rpc.helius.test";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        jsonRpcResponse({ jsonrpc: "2.0", id: 1, result: { solanaCore: "2.0.0" } }, 200)
      );

    const first = await relayProxy({ jsonrpc: "2.0", id: 1, method: "getVersion", params: [] });
    const second = await relayProxy({ jsonrpc: "2.0", id: 2, method: "getVersion", params: [] });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(firstBody.data.provider.id).toBe("triton");
    expect(secondBody.data.provider.id).toBe("helius");
    expect(fetchSpy.mock.calls.map(([input]) => new URL(String(input)).host)).toEqual([
      "rpc.triton.test",
      "rpc.helius.test",
    ]);
  });

  describe("faucet airdrop failover", () => {
    const airdrop = {
      jsonrpc: "2.0",
      id: "faucet-test",
      method: "requestAirdrop",
      params: [OWNED_FAUCET_ADDRESS, 1],
    };
    const rateLimited = {
      jsonrpc: "2.0",
      id: "faucet-test",
      error: { code: -32429, message: "Too many airdrop requests" },
    };
    const faucetDry = {
      jsonrpc: "2.0",
      id: "faucet-test",
      error: { code: -32603, message: "Faucet has run dry" },
    };

    function upstreamHosts(fetchSpy: MockInstance<typeof fetch>): string[] {
      return fetchSpy.mock.calls.map(([input]) => new URL(String(input)).host);
    }

    beforeEach(async () => {
      await seedCustodyWalletForProject(
        TEST_ORG.id,
        TEST_PROJECT_ID,
        OWNED_FAUCET_ADDRESS,
        "failover",
        "active"
      );
      env.SOLANA_RPC_TRITON_URL = "https://rpc.triton.test";
      env.SOLANA_RPC_HELIUS_URL = "https://rpc.helius.test/";
    });

    it("hops to the next provider when the first answers a JSON-RPC error", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        if (String(input).includes("rpc.triton.test")) {
          return jsonRpcResponse(rateLimited, 429);
        }
        return jsonRpcResponse(
          { jsonrpc: "2.0", id: "faucet-test", result: "helius_airdrop_sig" },
          200
        );
      });

      const response = await relayProxy(airdrop);

      expect(response.status).toBe(200);
      expect(upstreamHosts(fetchSpy)).toEqual(["rpc.triton.test", "rpc.helius.test"]);
      const body = await response.json();
      expect(body.data.provider).toEqual({ id: "helius", endpoint: "https://rpc.helius.test/" });
      expect(body.data.response.result).toBe("helius_airdrop_sig");
    });

    it("hops to the next provider when the first throws", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        if (String(input).includes("rpc.triton.test")) {
          throw new TypeError("fetch failed");
        }
        return jsonRpcResponse(
          { jsonrpc: "2.0", id: "faucet-test", result: "helius_airdrop_sig" },
          200
        );
      });

      const response = await relayProxy(airdrop);

      expect(response.status).toBe(200);
      expect(upstreamHosts(fetchSpy)).toEqual(["rpc.triton.test", "rpc.helius.test"]);
      const body = await response.json();
      expect(body.data.provider.id).toBe("helius");
      expect(body.data.response.result).toBe("helius_airdrop_sig");
    });

    it("answers the last provider's JSON-RPC error with 200 when every provider refuses", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input) =>
          String(input).includes("rpc.triton.test")
            ? jsonRpcResponse(rateLimited, 429)
            : jsonRpcResponse(faucetDry, 200)
        );

      const response = await relayProxy(airdrop);

      expect(response.status).toBe(200);
      expect(upstreamHosts(fetchSpy)).toEqual(["rpc.triton.test", "rpc.helius.test"]);
      const body = await response.json();
      expect(body.data.provider).toEqual({ id: "helius", endpoint: "https://rpc.helius.test/" });
      expect(body.data.upstream).toEqual({ ok: true, status: 200, statusText: "" });
      expect(body.data.response).toEqual(faucetDry);
    });

    it("answers the refusing provider's response when a later provider throws", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        if (String(input).includes("rpc.triton.test")) {
          return jsonRpcResponse(rateLimited, 429);
        }
        throw new TypeError("fetch failed");
      });

      const response = await relayProxy(airdrop);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.provider.id).toBe("triton");
      expect(body.data.upstream.status).toBe(429);
      expect(body.data.response).toEqual(rateLimited);
    });

    it("fails with SOLANA_RPC_ERROR when every provider throws", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new TypeError("fetch failed"));

      const response = await relayProxy(airdrop);

      expect(response.status).toBe(502);
      expect(upstreamHosts(fetchSpy)).toEqual(["rpc.triton.test", "rpc.helius.test"]);
      const body = await response.json();
      expect(body.error.code).toBe("SOLANA_RPC_ERROR");
    });

    it("fails with SOLANA_RPC_TIMEOUT when every provider times out", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));

      const response = await relayProxy(airdrop);

      expect(response.status).toBe(504);
      expect(upstreamHosts(fetchSpy)).toEqual(["rpc.triton.test", "rpc.helius.test"]);
      const body = await response.json();
      expect(body.error.code).toBe("SOLANA_RPC_TIMEOUT");
    });

    it("sends a batch-wrapped airdrop to a single provider without hopping", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(jsonRpcResponse([rateLimited], 200));

      const response = await relayProxy([airdrop]);

      expect(response.status).toBe(200);
      expect(upstreamHosts(fetchSpy)).toEqual(["rpc.triton.test"]);
      const body = await response.json();
      expect(body.data.provider.id).toBe("triton");
      expect(body.data.response).toEqual([rateLimited]);
    });
  });

  describe("faucet destination binding", () => {
    const UNOWNED_ADDRESS = "So11111111111111111111111111111111111111112";
    const OTHER_ORG_ID = "org_other_faucet_tenant";
    const OTHER_ORG_PROJECT_ID = "prj_other_faucet_tenant";
    const OTHER_ORG_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

    function airdropRequest(destination: unknown) {
      return {
        jsonrpc: "2.0",
        id: "faucet-binding-test",
        method: "requestAirdrop",
        params: [destination, 1],
      };
    }

    beforeEach(() => {
      env.SOLANA_RPC_TRITON_URL = "https://rpc.triton.test";
    });

    it("refuses a destination no tenant wallet owns, before any upstream call", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const response = await relayProxy(airdropRequest(UNOWNED_ADDRESS));

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error.message).toContain("not a wallet of this organization");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("refuses another organization's wallet as a destination", async () => {
      const db = getDb(env);
      await db
        .prepare(
          "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, 'Other Org', 'other-org-faucet', 'enterprise', 'active')"
        )
        .bind(OTHER_ORG_ID)
        .run();
      await seedDefaultProjects(db, {
        organizationId: OTHER_ORG_ID,
        createdBy: TEST_USER.id,
        members: [],
        ids: { sandbox: OTHER_ORG_PROJECT_ID, production: `${OTHER_ORG_PROJECT_ID}_production` },
      });
      await seedCustodyWalletForProject(
        OTHER_ORG_ID,
        OTHER_ORG_PROJECT_ID,
        OTHER_ORG_ADDRESS,
        "other_org",
        "active"
      );

      const response = await relayProxy(airdropRequest(OTHER_ORG_ADDRESS));
      expect(response.status).toBe(403);
    });

    it("refuses an unowned destination smuggled inside a JSON-RPC batch array", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const response = await relayProxy([
        { jsonrpc: "2.0", id: 1, method: "getVersion", params: [] },
        airdropRequest(UNOWNED_ADDRESS),
      ]);

      expect(response.status).toBe(403);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("refuses the tenant's own wallet once it is no longer active", async () => {
      await seedCustodyWalletForProject(
        TEST_ORG.id,
        TEST_PROJECT_ID,
        "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T",
        "inactive_wallet",
        "inactive"
      );

      const response = await relayProxy(
        airdropRequest("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T")
      );
      expect(response.status).toBe(403);
    });

    it("refuses a malformed destination as bad input rather than forwarding it", async () => {
      const response = await relayProxy(airdropRequest("not-a-base58-address"));
      expect(response.status).toBe(400);

      const missingParams = await relayProxy({
        jsonrpc: "2.0",
        id: 1,
        method: "requestAirdrop",
      });
      expect(missingParams.status).toBe(400);
    });

    it("relays an airdrop bound to the tenant's own wallet inside a batch array", async () => {
      env.SOLANA_RPC_TRITON_API_KEY = "triton_key";
      await seedCustodyWalletForProject(
        TEST_ORG.id,
        TEST_PROJECT_ID,
        OWNED_FAUCET_ADDRESS,
        "batch_owned",
        "active"
      );
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          jsonRpcResponse([{ jsonrpc: "2.0", id: 1, result: "owned_airdrop_sig" }], 200)
        );

      const response = await relayProxy([airdropRequest(OWNED_FAUCET_ADDRESS)]);

      expect(response.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalled();
    });
  });

  describe("relay boundaries", () => {
    it("refuses a method outside the Solana JSON-RPC surface without dialling upstream", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const response = await relayProxy({
        jsonrpc: "2.0",
        id: 1,
        method: "qn_fetchNFTs",
        params: [],
      });

      expect(response.status).toBe(400);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("refuses an oversized body before parsing it", async () => {
      const response = await relayProxy({
        jsonrpc: "2.0",
        id: 1,
        method: "getVersion",
        params: ["x".repeat(1024 * 1024 + 1024)],
      });

      expect(response.status).toBe(413);
    });

    it("429s the relay once the actor's quota is exhausted", async () => {
      await seedRateLimit(env, `metered:rpc:org:${TEST_ORG.id}:key:${TEST_API_KEY_ID}`, 100_000);

      const response = await relayProxy({
        jsonrpc: "2.0",
        id: 1,
        method: "getVersion",
        params: [],
      });

      expect(response.status).toBe(429);
      const body = await response.json();
      expect(body.error.code).toBe("RATE_LIMITED");
    });

    it("answers a distinct code when the upstream times out", async () => {
      env.SOLANA_RPC_TRITON_URL = "https://rpc.triton.test";
      env.SOLANA_RPC_TRITON_API_KEY = "triton_key";
      vi.spyOn(globalThis, "fetch").mockRejectedValue(
        new DOMException("The operation timed out.", "TimeoutError")
      );

      const response = await relayProxy({
        jsonrpc: "2.0",
        id: 1,
        method: "sendTransaction",
        params: [],
      });

      expect(response.status).toBe(504);
      const body = await response.json();
      expect(body.error.code).toBe("SOLANA_RPC_TIMEOUT");
    });

    it("charges the quota by batch size", async () => {
      // One admitted batch of N is N node calls; the pool must see N, or the
      // per-minute ceiling is really ceiling × batch cap.
      await seedRateLimit(env, `metered:rpc:org:${TEST_ORG.id}:key:${TEST_API_KEY_ID}`, 299);

      const batch = await relayProxy([
        { jsonrpc: "2.0", id: 1, method: "getSlot", params: [] },
        { jsonrpc: "2.0", id: 2, method: "getSlot", params: [] },
      ]);

      expect(batch.status).toBe(429);
    });
  });
});
