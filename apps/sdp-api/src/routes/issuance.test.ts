/**
 * Issuance Routes E2E Tests
 */

import * as MosaicSdk from "@solana/mosaic-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { hashString } from "@/lib/hash";
import * as AuthorityResolution from "@/routes/issuance/handlers/authority-resolution";
import { MosaicService } from "@/services/mosaic";
import * as SolanaServices from "@/services/solana";
import { TokenService } from "@/services/token.service";
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
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";

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
    const db = getDb(env);
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
      .prepare("DELETE FROM token_allowlist_statuses")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM token_allowlists")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM issuance_transaction_statuses")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM issuance_transactions")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM issued_token_extensions")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM issued_tokens")
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
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
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

    it("creates token with mixed-case symbol", async () => {
      const res = await app.request(
        "/v1/issuance/tokens",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({
            name: "Mixed Case Symbol Token",
            symbol: "UsdX9",
          }),
        },
        env
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.token.symbol).toBe("UsdX9");
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
            symbol: "invalid_symbol",
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

    it("updates deployed token metadata on-chain before persisting local fields", async () => {
      const db = getDb(env);
      const activeTokenId = "tok_metadataupdate1";

      await db
        .prepare(
          `INSERT INTO issued_tokens (
            id, project_id, organization_id, signing_wallet_id, mint_address, mint_authority,
            metadata_authority, freeze_authority, name, symbol, decimals, description, uri,
            image_url, total_supply_cached, is_mintable, freeze_authority_enabled,
            allowlist_enabled, status, deployed_at, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '0', 1, 1, 0, 'active', ?, ?)`
        )
        .bind(
          activeTokenId,
          TEST_PROJECT.id,
          TEST_ORG.id,
          null,
          TEST_ACTIVE_TOKEN.mintAddress,
          TEST_ACTIVE_TOKEN.mintAuthority,
          TEST_SOLANA_ADDRESSES.wallet3,
          TEST_ACTIVE_TOKEN.freezeAuthority,
          "Deployed Token",
          "DPLY",
          6,
          null,
          "https://example.com/original.json",
          null,
          "2024-01-02T00:00:00.000Z",
          TEST_PROJECT_API_KEY.id
        )
        .run();

      const resolveCurrentAuthoritySpy = vi
        .spyOn(AuthorityResolution, "resolveCurrentAuthorityForRole")
        .mockResolvedValueOnce(TEST_SOLANA_ADDRESSES.wallet3);
      const resolveAuthoritySignerSpy = vi
        .spyOn(AuthorityResolution, "resolveAuthoritySigner")
        .mockResolvedValueOnce({
          signer: { address: TEST_SOLANA_ADDRESSES.wallet3 } as never,
          walletId: "wal_test_metadata",
        });
      const updateMetadataSpy = vi
        .spyOn(MosaicService.prototype, "updateMetadata")
        .mockResolvedValueOnce({
          signature: "sig_metadata_update",
          slot: 123n,
        });

      try {
        const res = await app.request(
          `/v1/issuance/tokens/${activeTokenId}`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
            },
            body: JSON.stringify({
              name: "On-chain Updated Name",
              description: "On-chain description",
              uri: "https://example.com/updated.json",
              imageUrl: "https://example.com/token.png",
            }),
          },
          env
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.token.name).toBe("On-chain Updated Name");
        expect(body.data.token.description).toBe("On-chain description");
        expect(body.data.token.uri).toBe("https://example.com/updated.json");
        expect(body.data.token.imageUrl).toBe("https://example.com/token.png");

        expect(resolveCurrentAuthoritySpy).toHaveBeenCalledWith(
          env,
          expect.anything(),
          expect.objectContaining({ id: activeTokenId }),
          "metadata"
        );
        expect(resolveAuthoritySignerSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            auth: expect.objectContaining({ organizationId: TEST_ORG.id }),
            token: expect.objectContaining({ id: activeTokenId }),
            currentAuthority: TEST_SOLANA_ADDRESSES.wallet3,
          })
        );
        expect(updateMetadataSpy).toHaveBeenCalledWith({
          mint: TEST_ACTIVE_TOKEN.mintAddress,
          name: "On-chain Updated Name",
          description: "On-chain description",
          uri: "https://example.com/updated.json",
          imageUrl: "https://example.com/token.png",
          updateAuthority: expect.objectContaining({ address: TEST_SOLANA_ADDRESSES.wallet3 }),
          feePayer: expect.objectContaining({ address: TEST_SOLANA_ADDRESSES.wallet3 }),
        });
      } finally {
        resolveCurrentAuthoritySpy.mockRestore();
        resolveAuthoritySignerSpy.mockRestore();
        updateMetadataSpy.mockRestore();
      }
    });
  });

  describe("POST /v1/issuance/tokens/:tokenId/supply/refresh", () => {
    let activeTokenId: string;

    beforeEach(async () => {
      if (!(env as { SOLANA_RPC_URL?: string }).SOLANA_RPC_URL) {
        (env as { SOLANA_RPC_URL?: string }).SOLANA_RPC_URL = "https://rpc.invalid.test";
      }

      const db = getDb(env);

      await db
        .prepare(
          `INSERT INTO issued_tokens (id, project_id, organization_id, mint_address, mint_authority, freeze_authority,
           name, symbol, decimals, total_supply_cached, is_mintable, freeze_authority_enabled, allowlist_enabled, status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, 'Refresh Token', 'RFSH', 9, '0', 1, 1, 0, 'active', ?)`
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

    it("refreshes cached supply from RPC", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "1",
            result: {
              value: {
                amount: "1500000000",
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      const res = await app.request(
        `/v1/issuance/tokens/${activeTokenId}/supply/refresh`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}` },
        },
        env
      );

      fetchSpy.mockRestore();

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.token.id).toBe(activeTokenId);
      expect(body.data.token.totalSupply).toBe("1.5");
      expect(body.data.token.totalSupplyUpdatedAt).toBeDefined();
    });

    it("returns 400 for undeployed token", async () => {
      const createRes = await app.request(
        "/v1/issuance/tokens",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({ name: "Pending Token", symbol: "PND" }),
        },
        env
      );
      const created = await createRes.json();
      const pendingTokenId = created.data.token.id;

      const res = await app.request(
        `/v1/issuance/tokens/${pendingTokenId}/supply/refresh`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("TOKEN_NOT_DEPLOYED");
    });

    it("returns 502 when RPC call fails", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("upstream unavailable", { status: 503 }));

      const res = await app.request(
        `/v1/issuance/tokens/${activeTokenId}/supply/refresh`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}` },
        },
        env
      );

      fetchSpy.mockRestore();

      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error.code).toBe("SOLANA_RPC_ERROR");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Mint Operation Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("POST /v1/issuance/tokens/:tokenId/mint/prepare", () => {
    let activeTokenId: string;

    beforeEach(async () => {
      const db = getDb(env);

      // Insert an active (deployed) token directly
      await db
        .prepare(
          `INSERT INTO issued_tokens (id, project_id, organization_id, mint_address, mint_authority, freeze_authority,
           name, symbol, decimals, total_supply_cached, max_supply, is_mintable, freeze_authority_enabled, allowlist_enabled, status, created_by)
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
              amount: "1",
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
              amount: "1",
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
      const db = getDb(env);

      // Update token to have small max supply
      await db
        .prepare(
          "UPDATE issued_tokens SET max_supply = '100000000000', total_supply_cached = '50000000000' WHERE id = ?"
        )
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

    it("returns 400 for paused token", async () => {
      const db = getDb(env);
      await db
        .prepare("UPDATE issued_tokens SET status = 'paused' WHERE id = ?")
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
              amount: "1",
            },
          }),
        },
        env
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("TOKEN_PAUSED");
    });

    it("returns 400 for zero mint amount", async () => {
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
              amount: "0",
            },
          }),
        },
        env
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("INVALID_TOKEN_AMOUNT");
    });
  });

  describe("Token Operation Policy", () => {
    const policyTokenId = "tok_operationpolicy";

    beforeEach(async () => {
      await getDb(env)
        .prepare(
          `INSERT INTO issued_tokens (id, project_id, organization_id, mint_address, mint_authority, freeze_authority,
           name, symbol, decimals, total_supply_cached, is_mintable, freeze_authority_enabled, allowlist_enabled, status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, 'Operation Policy Token', 'OPP', 9, '0', 1, 1, 0, 'active', ?)`
        )
        .bind(
          policyTokenId,
          TEST_PROJECT.id,
          TEST_ORG.id,
          TEST_ACTIVE_TOKEN.mintAddress,
          TEST_ACTIVE_TOKEN.mintAuthority,
          TEST_ACTIVE_TOKEN.freezeAuthority,
          TEST_PROJECT_API_KEY.id
        )
        .run();
    });

    it("rejects zero force-burn amount before authority resolution", async () => {
      const res = await app.request(
        `/v1/issuance/tokens/${policyTokenId}/force-burn/prepare`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({
            forceBurn: {
              source: TEST_SOLANA_ADDRESSES.wallet1,
              amount: "0",
            },
          }),
        },
        env
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("INVALID_TOKEN_AMOUNT");
    });

    it("rejects zero seize amount before authority resolution", async () => {
      const res = await app.request(
        `/v1/issuance/tokens/${policyTokenId}/seize/prepare`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({
            seize: {
              source: TEST_SOLANA_ADDRESSES.wallet1,
              destination: TEST_SOLANA_ADDRESSES.wallet2,
              amount: "0",
            },
          }),
        },
        env
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("INVALID_TOKEN_AMOUNT");
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

      it("syncs the control list on-chain when an ABL address is configured", async () => {
        const db = getDb(env);
        await db
          .prepare("UPDATE issued_tokens SET abl_list_address = ? WHERE id = ?")
          .bind(TEST_SOLANA_ADDRESSES.wallet3, tokenId)
          .run();

        const createOrgSignerSpy = vi
          .spyOn(SolanaServices, "createOrgSigner")
          .mockResolvedValueOnce({ address: TEST_SOLANA_ADDRESSES.wallet2 } as never);
        const addToListSpy = vi
          .spyOn(MosaicService.prototype, "addToList")
          .mockResolvedValueOnce(undefined as never);

        try {
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
                label: "On-chain Wallet",
              }),
            },
            env
          );

          expect(res.status).toBe(201);
          expect(createOrgSignerSpy).toHaveBeenCalled();
          expect(addToListSpy).toHaveBeenCalledWith({
            list: TEST_SOLANA_ADDRESSES.wallet3,
            authority: TEST_SOLANA_ADDRESSES.wallet2,
            feePayer: TEST_SOLANA_ADDRESSES.wallet2,
            wallet: TEST_SOLANA_ADDRESSES.wallet1,
          });
        } finally {
          createOrgSignerSpy.mockRestore();
          addToListSpy.mockRestore();
        }
      });

      it("surfaces both errors when add compensation fails", async () => {
        const db = getDb(env);
        await db
          .prepare("UPDATE issued_tokens SET abl_list_address = ? WHERE id = ?")
          .bind(TEST_SOLANA_ADDRESSES.wallet3, tokenId)
          .run();

        const createOrgSignerSpy = vi
          .spyOn(SolanaServices, "createOrgSigner")
          .mockResolvedValueOnce({ address: TEST_SOLANA_ADDRESSES.wallet2 } as never);
        const addToListSpy = vi
          .spyOn(MosaicService.prototype, "addToList")
          .mockRejectedValueOnce(new Error("on-chain add failed"));
        const revokeAllowlistEntrySpy = vi
          .spyOn(TokenService.prototype, "revokeAllowlistEntry")
          .mockRejectedValueOnce(new Error("rollback failed"));

        try {
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
                label: "On-chain Wallet",
              }),
            },
            env
          );

          expect(res.status).toBe(500);
          const body = await res.json();
          expect(body.error.code).toBe("INTERNAL_ERROR");
          expect(body.error.details.originalError).toBe("on-chain add failed");
          expect(body.error.details.restoreError).toBe("rollback failed");
        } finally {
          createOrgSignerSpy.mockRestore();
          addToListSpy.mockRestore();
          revokeAllowlistEntrySpy.mockRestore();
        }
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

      it("syncs control-list removals on-chain when an ABL address is configured", async () => {
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

        const db = getDb(env);
        await db
          .prepare("UPDATE issued_tokens SET abl_list_address = ? WHERE id = ?")
          .bind(TEST_SOLANA_ADDRESSES.wallet3, tokenId)
          .run();

        const listRes = await app.request(
          `/v1/issuance/tokens/${tokenId}/allowlist`,
          {
            headers: { Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}` },
          },
          env
        );
        const listBody = await listRes.json();
        const entryId = listBody.data[0].id;

        const createOrgSignerSpy = vi
          .spyOn(SolanaServices, "createOrgSigner")
          .mockResolvedValueOnce({ address: TEST_SOLANA_ADDRESSES.wallet2 } as never);
        const removeFromListSpy = vi
          .spyOn(MosaicService.prototype, "removeFromList")
          .mockResolvedValueOnce(undefined as never);

        try {
          const res = await app.request(
            `/v1/issuance/tokens/${tokenId}/allowlist/${entryId}`,
            {
              method: "DELETE",
              headers: { Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}` },
            },
            env
          );

          expect(res.status).toBe(204);
          expect(createOrgSignerSpy).toHaveBeenCalled();
          expect(removeFromListSpy).toHaveBeenCalledWith({
            list: TEST_SOLANA_ADDRESSES.wallet3,
            authority: TEST_SOLANA_ADDRESSES.wallet2,
            feePayer: TEST_SOLANA_ADDRESSES.wallet2,
            wallet: TEST_SOLANA_ADDRESSES.wallet1,
          });
        } finally {
          createOrgSignerSpy.mockRestore();
          removeFromListSpy.mockRestore();
        }
      });

      it("restores the database entry if on-chain control-list removal fails", async () => {
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

        const db = getDb(env);
        await db
          .prepare("UPDATE issued_tokens SET abl_list_address = ? WHERE id = ?")
          .bind(TEST_SOLANA_ADDRESSES.wallet3, tokenId)
          .run();

        const listRes = await app.request(
          `/v1/issuance/tokens/${tokenId}/allowlist`,
          {
            headers: { Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}` },
          },
          env
        );
        const listBody = await listRes.json();
        const entryId = listBody.data[0].id;

        const createOrgSignerSpy = vi
          .spyOn(SolanaServices, "createOrgSigner")
          .mockResolvedValueOnce({ address: TEST_SOLANA_ADDRESSES.wallet2 } as never);
        const removeFromListSpy = vi
          .spyOn(MosaicService.prototype, "removeFromList")
          .mockRejectedValueOnce(new Error("mosaic removal failed"));

        try {
          const res = await app.request(
            `/v1/issuance/tokens/${tokenId}/allowlist/${entryId}`,
            {
              method: "DELETE",
              headers: { Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}` },
            },
            env
          );

          expect(res.status).toBe(500);

          const restoredListRes = await app.request(
            `/v1/issuance/tokens/${tokenId}/allowlist`,
            {
              headers: { Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}` },
            },
            env
          );
          const restoredListBody = await restoredListRes.json();
          expect(restoredListBody.data).toHaveLength(1);
          expect(restoredListBody.data[0].id).toBe(entryId);
        } finally {
          createOrgSignerSpy.mockRestore();
          removeFromListSpy.mockRestore();
        }
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Freeze/Unfreeze Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe.skipIf(isMockMode)("Freeze/Unfreeze Operations", () => {
    const seedFreezableToken = async (): Promise<string> => {
      const db = getDb(env);

      // Insert an active token with freeze capability
      await db
        .prepare(
          `INSERT INTO issued_tokens (id, project_id, organization_id, mint_address, mint_authority, freeze_authority,
           name, symbol, decimals, total_supply_cached, is_mintable, freeze_authority_enabled, allowlist_enabled, status, created_by)
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

      return TEST_ACTIVE_TOKEN.id;
    };

    const mockResolvedTokenAccount = () =>
      vi.spyOn(MosaicSdk, "resolveTokenAccount").mockResolvedValue({
        tokenAccount: TEST_SOLANA_ADDRESSES.wallet2,
        isInitialized: true,
        isFrozen: false,
        balance: 0n,
        uiBalance: 0,
      } as Awaited<ReturnType<typeof MosaicSdk.resolveTokenAccount>>);

    describe("POST /v1/issuance/tokens/:tokenId/freeze", () => {
      it("freezes an account", async () => {
        const activeTokenId = await seedFreezableToken();
        mockResolvedTokenAccount();

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
        expect(body.data.frozenAccount.accountAddress).toBe(TEST_SOLANA_ADDRESSES.wallet2);
        expect(body.data.frozenAccount.reason).toBe("Suspicious activity");
      });

      it("returns 400 for already frozen account", async () => {
        const activeTokenId = await seedFreezableToken();
        mockResolvedTokenAccount();

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

      it("returns a structured token-account error when the wallet does not hold this mint", async () => {
        const activeTokenId = await seedFreezableToken();
        mockResolvedTokenAccount();
        vi.mocked(MosaicSdk.resolveTokenAccount).mockResolvedValueOnce({
          tokenAccount: TEST_SOLANA_ADDRESSES.wallet2,
          isInitialized: false,
          isFrozen: true,
          balance: 0n,
          uiBalance: 0,
        } as Awaited<ReturnType<typeof MosaicSdk.resolveTokenAccount>>);

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
            }),
          },
          env
        );

        expect(res.status).toBe(400);
        const body = (await res.json()) as {
          error: {
            code: string;
            message: string;
            details?: { field?: string; hint?: string };
          };
        };
        expect(body.error.code).toBe("TOKEN_ACCOUNT_NOT_FOUND");
        expect(body.error.message).toContain("wallet");
        expect(body.error.details?.field).toBe("accountAddress");
        expect(body.error.details?.hint).toContain("holds this token");
      });

      it("maps token-account parser failures to a structured wallet error", async () => {
        const activeTokenId = await seedFreezableToken();
        mockResolvedTokenAccount();
        vi.spyOn(MosaicService.prototype, "freezeAccount").mockRejectedValueOnce(
          new Error("Failed to parse token account data")
        );

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
            }),
          },
          env
        );

        expect(res.status).toBe(400);
        const body = (await res.json()) as {
          error: {
            code: string;
            message: string;
            details?: { field?: string; hint?: string };
          };
        };
        expect(body.error.code).toBe("TOKEN_ACCOUNT_NOT_FOUND");
        expect(body.error.message).toContain("wallet");
        expect(body.error.details?.field).toBe("accountAddress");
        expect(body.error.details?.hint).toContain("matching token account");
      });

      it("can freeze an account again after it was unfrozen", async () => {
        const activeTokenId = await seedFreezableToken();
        const db = getDb(env);
        mockResolvedTokenAccount();

        const freezeSpy = vi.spyOn(MosaicService.prototype, "freezeAccount").mockResolvedValue({
          signature: "sig_freeze_refreeze",
          slot: 123n,
        });
        const thawSpy = vi.spyOn(MosaicService.prototype, "thawAccount").mockResolvedValue({
          signature: "sig_thaw_refreeze",
          slot: 124n,
        });

        try {
          const firstFreezeRes = await app.request(
            `/v1/issuance/tokens/${activeTokenId}/freeze`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
              },
              body: JSON.stringify({
                accountAddress: TEST_SOLANA_ADDRESSES.wallet1,
                reason: "Initial freeze",
              }),
            },
            env
          );

          expect(firstFreezeRes.status).toBe(201);
          const firstFreezeBody = await firstFreezeRes.json();
          const frozenRecordId = firstFreezeBody.data.frozenAccount.id as string;

          const unfreezeRes = await app.request(
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

          expect(unfreezeRes.status).toBe(200);

          const secondFreezeRes = await app.request(
            `/v1/issuance/tokens/${activeTokenId}/freeze`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
              },
              body: JSON.stringify({
                accountAddress: TEST_SOLANA_ADDRESSES.wallet1,
                reason: "Frozen again",
              }),
            },
            env
          );

          expect(secondFreezeRes.status).toBe(201);
          const secondFreezeBody = await secondFreezeRes.json();
          expect(secondFreezeBody.data.frozenAccount.id).toBe(frozenRecordId);
          expect(secondFreezeBody.data.frozenAccount.reason).toBe("Frozen again");

          const storedRows = await db
            .prepare(
              `SELECT id, unfrozen_at, reason
               FROM frozen_accounts
               WHERE token_id = ? AND account_address = ?`
            )
            .bind(activeTokenId, TEST_SOLANA_ADDRESSES.wallet2)
            .all<{ id: string; unfrozen_at: string | null; reason: string | null }>();

          expect(storedRows.results).toHaveLength(1);
          expect(storedRows.results[0]?.id).toBe(frozenRecordId);
          expect(storedRows.results[0]?.unfrozen_at).toBeNull();
          expect(storedRows.results[0]?.reason).toBe("Frozen again");
        } finally {
          freezeSpy.mockRestore();
          thawSpy.mockRestore();
        }
      });
    });

    describe("POST /v1/issuance/tokens/:tokenId/unfreeze", () => {
      it("unfreezes an account", async () => {
        const activeTokenId = await seedFreezableToken();
        mockResolvedTokenAccount();

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
        const activeTokenId = await seedFreezableToken();
        mockResolvedTokenAccount();

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
  // Mint with Control List Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Mint with Control List Enforcement", () => {
    let allowlistTokenId: string;
    const blocklistTokenId = "tok_blocklist_token";

    const addBlocklistEntry = async (address: string) => {
      await app.request(
        `/v1/issuance/tokens/${blocklistTokenId}/allowlist`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({ address }),
        },
        env
      );
    };

    beforeEach(async () => {
      const db = getDb(env);

      // Insert an active token that requires allowlist
      await db
        .prepare(
          `INSERT INTO issued_tokens (id, project_id, organization_id, mint_address, mint_authority, freeze_authority,
           name, symbol, decimals, total_supply_cached, is_mintable, freeze_authority_enabled, allowlist_enabled, status, created_by)
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

      await db
        .prepare(
          `INSERT INTO issued_tokens (id, project_id, organization_id, mint_address, mint_authority, freeze_authority,
           name, symbol, decimals, template, total_supply_cached, is_mintable, freeze_authority_enabled, allowlist_enabled, status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, 'Blocklist Token', 'BLT', 9, 'stablecoin', '0', 1, 1, 0, 'active', ?)`
        )
        .bind(
          blocklistTokenId,
          TEST_PROJECT.id,
          TEST_ORG.id,
          TEST_SOLANA_ADDRESSES.wallet3,
          TEST_ACTIVE_TOKEN.mintAuthority,
          TEST_ACTIVE_TOKEN.freezeAuthority,
          TEST_PROJECT_API_KEY.id
        )
        .run();
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
              amount: "1",
            },
          }),
        },
        env
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("NOT_ON_TOKEN_ALLOWLIST");
    });

    it("rejects execute mint to non-allowlisted address", async () => {
      const res = await app.request(
        `/v1/issuance/tokens/${allowlistTokenId}/mint`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({
            mint: {
              destination: TEST_SOLANA_ADDRESSES.wallet2,
              amount: "1",
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
              amount: "1",
            },
          }),
        },
        env
      );

      expect(res.status).toBe(200);
    });

    it("rejects mint to denylisted address", async () => {
      await addBlocklistEntry(TEST_SOLANA_ADDRESSES.wallet2);

      const res = await app.request(
        `/v1/issuance/tokens/${blocklistTokenId}/mint/prepare`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({
            mint: {
              destination: TEST_SOLANA_ADDRESSES.wallet2,
              amount: "1",
            },
          }),
        },
        env
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("ON_TOKEN_BLOCKLIST");
    });

    it("rejects execute mint to denylisted address", async () => {
      await addBlocklistEntry(TEST_SOLANA_ADDRESSES.wallet2);

      const res = await app.request(
        `/v1/issuance/tokens/${blocklistTokenId}/mint`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({
            mint: {
              destination: TEST_SOLANA_ADDRESSES.wallet2,
              amount: "1",
            },
          }),
        },
        env
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("ON_TOKEN_BLOCKLIST");
    });

    it("rejects prepare seize to denylisted destination", async () => {
      await addBlocklistEntry(TEST_SOLANA_ADDRESSES.wallet2);

      const res = await app.request(
        `/v1/issuance/tokens/${blocklistTokenId}/seize/prepare`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({
            seize: {
              source: TEST_SOLANA_ADDRESSES.wallet1,
              destination: TEST_SOLANA_ADDRESSES.wallet2,
              amount: "1",
            },
          }),
        },
        env
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("ON_TOKEN_BLOCKLIST");
    });

    it("rejects execute seize to denylisted destination", async () => {
      await addBlocklistEntry(TEST_SOLANA_ADDRESSES.wallet2);

      const res = await app.request(
        `/v1/issuance/tokens/${blocklistTokenId}/seize`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({
            seize: {
              source: TEST_SOLANA_ADDRESSES.wallet1,
              destination: TEST_SOLANA_ADDRESSES.wallet2,
              amount: "1",
            },
          }),
        },
        env
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("ON_TOKEN_BLOCKLIST");
    });

    it("rejects prepare seize to non-allowlisted destination", async () => {
      const res = await app.request(
        `/v1/issuance/tokens/${allowlistTokenId}/seize/prepare`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({
            seize: {
              source: TEST_SOLANA_ADDRESSES.wallet1,
              destination: TEST_SOLANA_ADDRESSES.wallet2,
              amount: "1",
            },
          }),
        },
        env
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("NOT_ON_TOKEN_ALLOWLIST");
    });

    it("rejects execute seize to non-allowlisted destination", async () => {
      const res = await app.request(
        `/v1/issuance/tokens/${allowlistTokenId}/seize`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({
            seize: {
              source: TEST_SOLANA_ADDRESSES.wallet1,
              destination: TEST_SOLANA_ADDRESSES.wallet2,
              amount: "1",
            },
          }),
        },
        env
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("NOT_ON_TOKEN_ALLOWLIST");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Template Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Templates API", () => {
    describe("GET /v1/issuance/templates", () => {
      it("lists publicly exposed templates", async () => {
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
        expect(body.data.templates.length).toBe(3);

        // Verify template structure
        const stablecoin = body.data.templates.find((t: { id: string }) => t.id === "stablecoin");
        expect(stablecoin).toBeDefined();
        expect(stablecoin.name).toBe("Stablecoin");
        expect(stablecoin.maxDecimals).toBe(18);
        const tokenized = body.data.templates.find(
          (t: { id: string }) => t.id === "tokenized-security"
        );
        expect(tokenized).toBeDefined();
        expect(tokenized.maxDecimals).toBe(18);
        const custom = body.data.templates.find((t: { id: string }) => t.id === "custom");
        expect(custom).toBeDefined();
        const arcade = body.data.templates.find((t: { id: string }) => t.id === "arcade");
        expect(arcade).toBeUndefined();
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
        expect(body.data.template.maxDecimals).toBe(18);
      });

      it("returns tokenized security template", async () => {
        const res = await app.request(
          "/v1/issuance/templates/tokenized-security",
          {
            headers: { Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}` },
          },
          env
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.template.id).toBe("tokenized-security");
        expect(body.data.template.name).toBe("Tokenized Security");
        expect(body.data.template.maxDecimals).toBe(18);
      });

      it("does not return arcade template", async () => {
        const res = await app.request(
          "/v1/issuance/templates/arcade",
          {
            headers: { Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}` },
          },
          env
        );

        expect(res.status).toBe(404);
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

    it("creates stablecoin with mixed-case symbol and decimal override", async () => {
      const res = await app.request(
        "/v1/issuance/tokens",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({
            name: "Custom Stablecoin Decimals",
            symbol: "Usd7",
            template: "stablecoin",
            decimals: 7,
          }),
        },
        env
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.token.template).toBe("stablecoin");
      expect(body.data.token.symbol).toBe("Usd7");
      expect(body.data.token.decimals).toBe(7);
    });

    it("creates tokenized security with decimal override", async () => {
      const res = await app.request(
        "/v1/issuance/tokens",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({
            name: "Custom Security Decimals",
            symbol: "Sec12",
            template: "tokenized-security",
            decimals: 12,
          }),
        },
        env
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.token.template).toBe("tokenized-security");
      expect(body.data.token.decimals).toBe(12);
      expect(body.data.token.requiresAllowlist).toBe(true);
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
            template: "custom",
            overrides: {
              extensions: {
                transferFee: {
                  basisPoints: 50,
                  maxFee: "0.5",
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

    it("creates token with advanced extension overrides", async () => {
      const extensionAuthority = TEST_SOLANA_ADDRESSES.wallet1;

      const res = await app.request(
        "/v1/issuance/tokens",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({
            name: "Advanced Extensions",
            symbol: "ADV",
            template: "custom",
            overrides: {
              extensions: {
                pausable: {
                  authority: extensionAuthority,
                },
                scaledUiAmount: {
                  multiplier: 2,
                  newMultiplier: 3,
                  newMultiplierEffectiveTimestamp: 1735689600,
                },
                transferHook: {
                  programId: extensionAuthority,
                  authority: extensionAuthority,
                },
              },
            },
          }),
        },
        env
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.token.extensions?.pausable?.authority).toBe(extensionAuthority);
      expect(body.data.token.extensions?.scaledUiAmount?.multiplier).toBe(2);
      expect(body.data.token.extensions?.transferHook?.programId).toBe(extensionAuthority);
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

    it("allows enabling allowlist for stablecoin", async () => {
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
              requiresAllowlist: true, // Stablecoin allows allowlist override
            },
          }),
        },
        env
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.token.requiresAllowlist).toBe(true);
      expect(body.data.token.extensions?.defaultAccountState).toBe("frozen");
    });

    it("allows tokenized-security to switch to denylist mode", async () => {
      const res = await app.request(
        "/v1/issuance/tokens",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
          },
          body: JSON.stringify({
            name: "Security Denylist Token",
            symbol: "SDLT",
            template: "tokenized-security",
            overrides: {
              requiresAllowlist: false,
            },
          }),
        },
        env
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.token.requiresAllowlist).toBe(false);
      expect(body.data.token.extensions?.defaultAccountState).toBe("initialized");
    });

    it("rejects disabling required extension for template", async () => {
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
                permanentDelegate: false,
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

    it("creates token with custom template overrides", async () => {
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
            template: "custom",
            overrides: {
              extensions: {
                defaultAccountState: "frozen",
              },
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
