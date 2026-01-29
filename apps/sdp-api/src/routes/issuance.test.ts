/**
 * Issuance Routes E2E Tests
 */

import app from "@/index";
import { hashString } from "@/lib/hash";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import {
  TEST_ACTIVE_TOKEN,
  TEST_ALLOWLIST_TOKEN,
  TEST_PROJECT,
  TEST_PROJECT_API_KEY,
  TEST_PROJECT_CACHED_KEY,
  TEST_SOLANA_ADDRESSES,
} from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/d1";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Check if running in mock mode (no RPC access)
const isMockMode = (env as { SOLANA_MOCK?: string }).SOLANA_MOCK === "true";

describe("Issuance Routes", () => {
  let apiKeyHash: string;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);

    // Pre-compute API key hash
    apiKeyHash = await hashString(
      TEST_PROJECT_API_KEY.raw,
      (env as { API_KEY_PEPPER: string }).API_KEY_PEPPER
    );
  });

  afterAll(async () => {
    await clearTestDatabase(env as Parameters<typeof clearTestDatabase>[0]);
  });

  beforeEach(async () => {
    const db = (env as { DB: D1Database }).DB;
    const apiKeysKV = (env as { SDP_API_KEYS: KVNamespace }).SDP_API_KEYS;
    const rateLimitKV = (env as { SDP_RATE_LIMITS: KVNamespace }).SDP_RATE_LIMITS;

    // Clear rate limit KV to prevent 429 errors between tests
    const keys = await rateLimitKV.list();
    for (const key of keys.keys) {
      await rateLimitKV.delete(key.name);
    }

    // Clear token-related tables
    await db
      .prepare("DELETE FROM frozen_accounts")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM token_allowlists")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM token_transactions")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM tokens")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM project_members")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM api_keys WHERE project_id IS NOT NULL")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM projects")
      .run()
      .catch(() => {});

    // Seed organization
    await db
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'free', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();

    // Seed user
    await db
      .prepare(
        "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
      )
      .bind(TEST_USER.id, TEST_USER.email)
      .run();

    // Seed project
    await db
      .prepare(
        `INSERT OR REPLACE INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_PROJECT.id,
        TEST_PROJECT.organizationId,
        TEST_PROJECT.name,
        TEST_PROJECT.slug,
        TEST_PROJECT.environment,
        TEST_PROJECT.status,
        TEST_PROJECT.createdBy
      )
      .run();

    // Seed project-scoped API key
    await db
      .prepare(
        `INSERT OR REPLACE INTO api_keys
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, environment, status)
         VALUES (?, ?, ?, ?, 'Project Test Key', ?, ?, 'api_admin', '["*"]', 'sandbox', 'active')`
      )
      .bind(
        TEST_PROJECT_API_KEY.id,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_USER.id,
        TEST_PROJECT_API_KEY.prefix,
        apiKeyHash
      )
      .run();

    // Cache API key in KV
    await apiKeysKV.put(`key:${apiKeyHash}`, JSON.stringify(TEST_PROJECT_CACHED_KEY));
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Token CRUD Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("POST /v1/issuance/tokens", () => {
    it("creates a new token", async () => {
      const res = await app.request(
        "/v1/issuance/tokens",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({
            name: "Test Stablecoin",
            symbol: "TUSD",
            decimals: 6,
            description: "A test stablecoin",
            maxSupply: "1000000000000000",
            requiresAllowlist: true,
          }),
        },
        env
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.token).toBeDefined();
      expect(body.data.token.id).toMatch(/^tok_/);
      expect(body.data.token.name).toBe("Test Stablecoin");
      expect(body.data.token.symbol).toBe("TUSD");
      expect(body.data.token.decimals).toBe(6);
      expect(body.data.token.status).toBe("pending");
      expect(body.data.token.requiresAllowlist).toBe(true);
      expect(body.data.token.projectId).toBe(TEST_PROJECT.id);
    });

    it("creates token with default decimals", async () => {
      const res = await app.request(
        "/v1/issuance/tokens",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({
            name: "Default Decimals Token",
            symbol: "DDT",
          }),
        },
        env
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.token.decimals).toBe(9);
    });

    it("returns 400 for invalid symbol", async () => {
      const res = await app.request(
        "/v1/issuance/tokens",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({
            name: "Invalid Symbol Token",
            symbol: "invalid_symbol", // lowercase and underscore
          }),
        },
        env
      );

      expect(res.status).toBe(400);
    });

    it("returns 401 without auth", async () => {
      const res = await app.request(
        "/v1/issuance/tokens",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Test", symbol: "TEST" }),
        },
        env
      );

      expect(res.status).toBe(401);
    });
  });

  describe("GET /v1/issuance/tokens", () => {
    beforeEach(async () => {
      // Create a token for listing
      await app.request(
        "/v1/issuance/tokens",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({ name: "Listed Token", symbol: "LIST" }),
        },
        env
      );
    });

    it("lists tokens for project", async () => {
      const res = await app.request(
        "/v1/issuance/tokens",
        {
          headers: { Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toBeInstanceOf(Array);
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data[0].name).toBe("Listed Token");
      expect(body.meta.total).toBeGreaterThan(0);
    });

    it("supports pagination", async () => {
      const res = await app.request(
        // biome-ignore lint/nursery/noSecrets: URL query string, not a secret
        "/v1/issuance/tokens?page=1&pageSize=10",
        {
          headers: { Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.meta.page).toBe(1);
      expect(body.meta.pageSize).toBe(10);
    });
  });

  describe("GET /v1/issuance/tokens/:tokenId", () => {
    let tokenId: string;

    beforeEach(async () => {
      const createRes = await app.request(
        "/v1/issuance/tokens",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({ name: "Detail Token", symbol: "DETAIL" }),
        },
        env
      );
      const created = await createRes.json();
      tokenId = created.data.token.id;
    });

    it("returns token details", async () => {
      const res = await app.request(
        `/v1/issuance/tokens/${tokenId}`,
        {
          headers: { Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.token.id).toBe(tokenId);
      expect(body.data.token.name).toBe("Detail Token");
    });

    it("returns 404 for non-existent token", async () => {
      const res = await app.request(
        "/v1/issuance/tokens/tok_nonexistent12",
        {
          headers: { Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /v1/issuance/tokens/:tokenId", () => {
    let tokenId: string;

    beforeEach(async () => {
      const createRes = await app.request(
        "/v1/issuance/tokens",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({ name: "Update Token", symbol: "UPDATE" }),
        },
        env
      );
      const created = await createRes.json();
      tokenId = created.data.token.id;
    });

    it("updates token details", async () => {
      const res = await app.request(
        `/v1/issuance/tokens/${tokenId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({
            name: "Updated Token Name",
            description: "New description",
          }),
        },
        env
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.token.name).toBe("Updated Token Name");
      expect(body.data.token.description).toBe("New description");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Mint Operation Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("POST /v1/issuance/tokens/:tokenId/mint/prepare", () => {
    let activeTokenId: string;

    beforeEach(async () => {
      const db = (env as { DB: D1Database }).DB;

      // Insert an active (deployed) token directly
      await db
        .prepare(
          `INSERT INTO tokens (id, project_id, organization_id, mint_address, mint_authority, freeze_authority,
           name, symbol, decimals, total_supply, max_supply, is_mintable, is_freezable, requires_allowlist, status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, 'Active Token', 'ACTIVE', 9, '0', '1000000000000000000', 1, 1, 0, 'active', ?)`
        )
        .bind(
          TEST_ACTIVE_TOKEN.id,
          TEST_PROJECT.id,
          TEST_ORG.id,
          TEST_ACTIVE_TOKEN.mintAddress,
          TEST_ACTIVE_TOKEN.mintAuthority,
          TEST_ACTIVE_TOKEN.freezeAuthority,
          TEST_PROJECT_API_KEY.id
        )
        .run();

      activeTokenId = TEST_ACTIVE_TOKEN.id;
    });

    // Skip in mock mode - Mosaic SDK requires RPC to fetch mint details
    it.skipIf(isMockMode)("prepares mint transaction", async () => {
      const res = await app.request(
        `/v1/issuance/tokens/${activeTokenId}/mint/prepare`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({
            mint: {
              destination: TEST_SOLANA_ADDRESSES.wallet1,
              amount: "1000000000",
            },
          }),
        },
        env
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.transaction).toBeDefined();
      expect(body.data.transaction.id).toMatch(/^ttx_/);
      expect(body.data.transaction.type).toBe("mint");
      expect(body.data.transaction.status).toBe("pending");
    });

    it("returns 400 for inactive token", async () => {
      // Create a pending (not deployed) token
      const createRes = await app.request(
        "/v1/issuance/tokens",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({ name: "Pending Token", symbol: "PEND" }),
        },
        env
      );
      const created = await createRes.json();
      const pendingTokenId = created.data.token.id;

      const res = await app.request(
        `/v1/issuance/tokens/${pendingTokenId}/mint/prepare`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({
            mint: {
              destination: TEST_SOLANA_ADDRESSES.wallet1,
              amount: "1000000000",
            },
          }),
        },
        env
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("TOKEN_NOT_ACTIVE");
    });

    it("returns 400 when max supply would be exceeded", async () => {
      const db = (env as { DB: D1Database }).DB;

      // Update token to have small max supply
      await db
        .prepare("UPDATE tokens SET max_supply = '100', total_supply = '50' WHERE id = ?")
        .bind(activeTokenId)
        .run();

      const res = await app.request(
        `/v1/issuance/tokens/${activeTokenId}/mint/prepare`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({
            mint: {
              destination: TEST_SOLANA_ADDRESSES.wallet1,
              amount: "100", // Would exceed max supply
            },
          }),
        },
        env
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("MAX_SUPPLY_EXCEEDED");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Allowlist Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Allowlist Management", () => {
    let tokenId: string;

    beforeEach(async () => {
      const createRes = await app.request(
        "/v1/issuance/tokens",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({
            name: "Allowlist Token",
            symbol: "ALLOW",
            requiresAllowlist: true,
          }),
        },
        env
      );
      const created = await createRes.json();
      tokenId = created.data.token.id;
    });

    describe("POST /v1/issuance/tokens/:tokenId/allowlist", () => {
      it("adds address to allowlist", async () => {
        const res = await app.request(
          `/v1/issuance/tokens/${tokenId}/allowlist`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
            },
            body: JSON.stringify({
              address: TEST_SOLANA_ADDRESSES.wallet1,
              label: "Test Wallet",
              kycStatus: "approved",
            }),
          },
          env
        );

        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.data.entry.id).toMatch(/^tal_/);
        expect(body.data.entry.address).toBe(TEST_SOLANA_ADDRESSES.wallet1);
        expect(body.data.entry.label).toBe("Test Wallet");
        expect(body.data.entry.status).toBe("active");
      });

      it("returns 409 for duplicate address", async () => {
        // Add first entry
        await app.request(
          `/v1/issuance/tokens/${tokenId}/allowlist`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
            },
            body: JSON.stringify({ address: TEST_SOLANA_ADDRESSES.wallet1 }),
          },
          env
        );

        // Try to add same address again
        const res = await app.request(
          `/v1/issuance/tokens/${tokenId}/allowlist`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
            },
            body: JSON.stringify({ address: TEST_SOLANA_ADDRESSES.wallet1 }),
          },
          env
        );

        expect(res.status).toBe(409);
      });
    });

    describe("GET /v1/issuance/tokens/:tokenId/allowlist", () => {
      it("lists allowlist entries", async () => {
        // Add an entry first
        await app.request(
          `/v1/issuance/tokens/${tokenId}/allowlist`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
            },
            body: JSON.stringify({
              address: TEST_SOLANA_ADDRESSES.wallet1,
              label: "Listed Wallet",
            }),
          },
          env
        );

        const res = await app.request(
          `/v1/issuance/tokens/${tokenId}/allowlist`,
          {
            headers: { Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}` },
          },
          env
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data).toBeInstanceOf(Array);
        expect(body.data.length).toBe(1);
        expect(body.data[0].label).toBe("Listed Wallet");
      });
    });

    describe("DELETE /v1/issuance/tokens/:tokenId/allowlist/:entryId", () => {
      it("revokes allowlist entry", async () => {
        // Add an entry
        const addRes = await app.request(
          `/v1/issuance/tokens/${tokenId}/allowlist`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
            },
            body: JSON.stringify({ address: TEST_SOLANA_ADDRESSES.wallet1 }),
          },
          env
        );
        const added = await addRes.json();
        const entryId = added.data.entry.id;

        // Delete it
        const res = await app.request(
          `/v1/issuance/tokens/${tokenId}/allowlist/${entryId}`,
          {
            method: "DELETE",
            headers: { Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}` },
          },
          env
        );

        expect(res.status).toBe(204);

        // Verify it's revoked
        const listRes = await app.request(
          `/v1/issuance/tokens/${tokenId}/allowlist`,
          {
            headers: { Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}` },
          },
          env
        );
        const listBody = await listRes.json();
        expect(listBody.data.length).toBe(0);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Freeze/Unfreeze Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Freeze/Unfreeze Operations", () => {
    let activeTokenId: string;

    beforeEach(async () => {
      const db = (env as { DB: D1Database }).DB;

      // Insert an active token with freeze capability
      await db
        .prepare(
          `INSERT INTO tokens (id, project_id, organization_id, mint_address, mint_authority, freeze_authority,
           name, symbol, decimals, total_supply, is_mintable, is_freezable, requires_allowlist, status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, 'Freezable Token', 'FRZ', 9, '0', 1, 1, 0, 'active', ?)`
        )
        .bind(
          TEST_ACTIVE_TOKEN.id,
          TEST_PROJECT.id,
          TEST_ORG.id,
          TEST_ACTIVE_TOKEN.mintAddress,
          TEST_ACTIVE_TOKEN.mintAuthority,
          TEST_ACTIVE_TOKEN.freezeAuthority,
          TEST_PROJECT_API_KEY.id
        )
        .run();

      activeTokenId = TEST_ACTIVE_TOKEN.id;
    });

    describe("POST /v1/issuance/tokens/:tokenId/freeze", () => {
      it("freezes an account", async () => {
        const res = await app.request(
          `/v1/issuance/tokens/${activeTokenId}/freeze`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
            },
            body: JSON.stringify({
              accountAddress: TEST_SOLANA_ADDRESSES.wallet1,
              reason: "Suspicious activity",
            }),
          },
          env
        );

        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.data.frozenAccount.id).toMatch(/^frz_/);
        expect(body.data.frozenAccount.accountAddress).toBe(TEST_SOLANA_ADDRESSES.wallet1);
        expect(body.data.frozenAccount.reason).toBe("Suspicious activity");
      });

      it("returns 400 for already frozen account", async () => {
        // Freeze first
        await app.request(
          `/v1/issuance/tokens/${activeTokenId}/freeze`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
            },
            body: JSON.stringify({ accountAddress: TEST_SOLANA_ADDRESSES.wallet1 }),
          },
          env
        );

        // Try to freeze again
        const res = await app.request(
          `/v1/issuance/tokens/${activeTokenId}/freeze`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
            },
            body: JSON.stringify({ accountAddress: TEST_SOLANA_ADDRESSES.wallet1 }),
          },
          env
        );

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error.code).toBe("ACCOUNT_FROZEN");
      });
    });

    describe("POST /v1/issuance/tokens/:tokenId/unfreeze", () => {
      it("unfreezes an account", async () => {
        // Freeze first
        await app.request(
          `/v1/issuance/tokens/${activeTokenId}/freeze`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
            },
            body: JSON.stringify({ accountAddress: TEST_SOLANA_ADDRESSES.wallet1 }),
          },
          env
        );

        // Unfreeze
        const res = await app.request(
          `/v1/issuance/tokens/${activeTokenId}/unfreeze`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
            },
            body: JSON.stringify({ accountAddress: TEST_SOLANA_ADDRESSES.wallet1 }),
          },
          env
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.frozenAccount.unfrozenAt).toBeDefined();
      });

      it("returns 400 for non-frozen account", async () => {
        const res = await app.request(
          `/v1/issuance/tokens/${activeTokenId}/unfreeze`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
            },
            body: JSON.stringify({ accountAddress: TEST_SOLANA_ADDRESSES.wallet1 }),
          },
          env
        );

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error.code).toBe("ACCOUNT_NOT_FROZEN");
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Mint with Allowlist Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Mint with Allowlist Enforcement", () => {
    let allowlistTokenId: string;

    beforeEach(async () => {
      const db = (env as { DB: D1Database }).DB;

      // Insert an active token that requires allowlist
      await db
        .prepare(
          `INSERT INTO tokens (id, project_id, organization_id, mint_address, mint_authority, freeze_authority,
           name, symbol, decimals, total_supply, is_mintable, is_freezable, requires_allowlist, status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, 'Allowlist Token', 'ALT', 9, '0', 1, 1, 1, 'active', ?)`
        )
        .bind(
          TEST_ALLOWLIST_TOKEN.id,
          TEST_PROJECT.id,
          TEST_ORG.id,
          TEST_ALLOWLIST_TOKEN.mintAddress,
          TEST_ACTIVE_TOKEN.mintAuthority,
          TEST_ACTIVE_TOKEN.freezeAuthority,
          TEST_PROJECT_API_KEY.id
        )
        .run();

      allowlistTokenId = TEST_ALLOWLIST_TOKEN.id;
    });

    it("rejects mint to non-allowlisted address", async () => {
      const res = await app.request(
        `/v1/issuance/tokens/${allowlistTokenId}/mint/prepare`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({
            mint: {
              destination: TEST_SOLANA_ADDRESSES.wallet2, // Not on allowlist
              amount: "1000000000",
            },
          }),
        },
        env
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("NOT_ON_TOKEN_ALLOWLIST");
    });

    // Skip in mock mode - Mosaic SDK requires RPC to fetch mint details
    it.skipIf(isMockMode)("allows mint to allowlisted address", async () => {
      // Add to allowlist first
      await app.request(
        `/v1/issuance/tokens/${allowlistTokenId}/allowlist`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({ address: TEST_SOLANA_ADDRESSES.wallet1 }),
        },
        env
      );

      // Now mint should work
      const res = await app.request(
        `/v1/issuance/tokens/${allowlistTokenId}/mint/prepare`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({
            mint: {
              destination: TEST_SOLANA_ADDRESSES.wallet1,
              amount: "1000000000",
            },
          }),
        },
        env
      );

      expect(res.status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Template Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Templates API", () => {
    describe("GET /v1/issuance/templates", () => {
      it("lists all templates", async () => {
        const res = await app.request(
          "/v1/issuance/templates",
          {
            headers: { Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}` },
          },
          env
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.templates).toBeInstanceOf(Array);
        expect(body.data.templates.length).toBe(4);

        // Verify template structure
        const stablecoin = body.data.templates.find((t: { id: string }) => t.id === "stablecoin");
        expect(stablecoin).toBeDefined();
        expect(stablecoin.name).toBe("Stablecoin");
        const tokenized = body.data.templates.find(
          (t: { id: string }) => t.id === "tokenized-security"
        );
        expect(tokenized).toBeDefined();
        const custom = body.data.templates.find((t: { id: string }) => t.id === "custom");
        expect(custom).toBeDefined();
      });
    });

    describe("GET /v1/issuance/templates/:templateId", () => {
      it("returns stablecoin template", async () => {
        const res = await app.request(
          "/v1/issuance/templates/stablecoin",
          {
            headers: { Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}` },
          },
          env
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.template.id).toBe("stablecoin");
        expect(body.data.template.name).toBe("Stablecoin");
      });

      it("returns arcade template", async () => {
        const res = await app.request(
          "/v1/issuance/templates/arcade",
          {
            headers: { Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}` },
          },
          env
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.template.id).toBe("arcade");
        expect(body.data.template.name).toBe("Arcade");
      });

      it("returns 404 for unknown template", async () => {
        const res = await app.request(
          "/v1/issuance/templates/nonexistent",
          {
            headers: { Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}` },
          },
          env
        );

        expect(res.status).toBe(404);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Template-Based Token Creation Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Template-based Token Creation", () => {
    it("creates token with arcade template", async () => {
      const res = await app.request(
        "/v1/issuance/tokens",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({
            name: "Arcade Token",
            symbol: "ARCADE",
            template: "arcade",
          }),
        },
        env
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.token.decimals).toBe(0); // Arcade default
      expect(body.data.token.requiresAllowlist).toBe(false);
      expect(body.data.token.extensions?.defaultAccountState).toBe("initialized");
    });

    it("creates token with rwa template", async () => {
      const res = await app.request(
        "/v1/issuance/tokens",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({
            name: "Real Estate Token",
            symbol: "RWA",
            template: "rwa",
          }),
        },
        env
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.token.decimals).toBe(8); // RWA default
      expect(body.data.token.requiresAllowlist).toBe(true);
      expect(body.data.token.extensions?.defaultAccountState).toBe("frozen");
    });

    it("creates token with decimal override", async () => {
      const res = await app.request(
        "/v1/issuance/tokens",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({
            name: "Custom Decimals Arcade",
            symbol: "CDA",
            template: "arcade",
            decimals: 6, // Override arcade's 0 decimals
          }),
        },
        env
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.token.decimals).toBe(6);
    });

    it("creates token with extension override", async () => {
      const res = await app.request(
        "/v1/issuance/tokens",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({
            name: "Token with Fees",
            symbol: "FEE",
            template: "arcade",
            overrides: {
              extensions: {
                transferFee: {
                  basisPoints: 50,
                  maxFee: "1000000",
                },
              },
            },
          }),
        },
        env
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.token.extensions?.transferFee).toBeDefined();
      expect(body.data.token.extensions?.transferFee?.basisPoints).toBe(50);
    });

    it("creates token with allowlist override", async () => {
      const res = await app.request(
        "/v1/issuance/tokens",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({
            name: "Allowlisted Arcade",
            symbol: "ALLARC",
            template: "arcade",
            overrides: {
              requiresAllowlist: true, // Arcade allows this override
            },
          }),
        },
        env
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.token.requiresAllowlist).toBe(true);
    });

    it("rejects disabling required allowlist for stablecoin", async () => {
      const res = await app.request(
        "/v1/issuance/tokens",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({
            name: "Invalid Stablecoin",
            symbol: "INVSC",
            template: "stablecoin",
            overrides: {
              requiresAllowlist: false, // Stablecoin doesn't allow this
              extensions: {
                confidentialTransfer: false, // Disable feature-flagged extension
              },
            },
          }),
        },
        env
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.details?.errors).toBeInstanceOf(Array);
      expect(
        body.error.details?.errors.some((e: { code: string }) => e.code === "ALLOWLIST_REQUIRED")
      ).toBe(true);
    });

    it("rejects incompatible extension for template", async () => {
      const res = await app.request(
        "/v1/issuance/tokens",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({
            name: "Invalid Arcade",
            symbol: "INVARC",
            template: "arcade",
            overrides: {
              extensions: {
                confidentialTransfer: true, // Arcade doesn't support CT
              },
            },
          }),
        },
        env
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.details?.errors).toBeInstanceOf(Array);
      expect(
        body.error.details?.errors.some((e: { code: string }) => e.code === "EXTENSION_NOT_ALLOWED")
      ).toBe(true);
    });

    it("creates token with legacy extensions format (backward compatibility)", async () => {
      const res = await app.request(
        "/v1/issuance/tokens",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({
            name: "Legacy Token",
            symbol: "LEGACY",
            // No template specified - legacy mode
            extensions: {
              defaultAccountState: "frozen",
            },
            requiresAllowlist: true,
          }),
        },
        env
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.token.decimals).toBe(9); // Custom template default
      expect(body.data.token.requiresAllowlist).toBe(true);
      expect(body.data.token.extensions?.defaultAccountState).toBe("frozen");
    });
  });
});
