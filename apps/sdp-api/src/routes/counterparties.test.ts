import { hashString } from "@sdp/payments/hash";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { TEST_API_KEY, TEST_CACHED_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";

const TEST_PROJECT_ID = "prj_counterparties_test";

describe("Counterparties Routes", () => {
  let apiKeyHash: string;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
    apiKeyHash = await hashString(
      TEST_API_KEY.raw,
      (env as { API_KEY_PEPPER: string }).API_KEY_PEPPER
    );
  });

  afterAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  beforeEach(async () => {
    const db = getDb(env);
    const kv = createKVStoreSet(env);

    const keys = await kv.rateLimits.list();
    for (const key of keys.keys) {
      await kv.rateLimits.delete(key.name);
    }

    await db
      .prepare("DELETE FROM counterparty_provider_accounts")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM counterparties")
      .run()
      .catch(() => {});
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
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();

    await db
      .prepare(
        "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
      )
      .bind(TEST_USER.id, TEST_USER.email)
      .run();

    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Test Project', 'test-project', 'sandbox', 'active', ?)`
      )
      .bind(TEST_PROJECT_ID, TEST_ORG.id, TEST_USER.id)
      .run();

    await db
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role)
         VALUES ('pm_test_counterparty', ?, ?, 'admin')`
      )
      .bind(TEST_PROJECT_ID, TEST_USER.id)
      .run();

    await db
      .prepare(
        `INSERT OR REPLACE INTO api_keys
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, 'Test Key', ?, ?, 'api_admin', '["*"]', 'active')`
      )
      .bind(
        TEST_API_KEY.id,
        TEST_ORG.id,
        TEST_PROJECT_ID,
        TEST_USER.id,
        TEST_API_KEY.prefix,
        apiKeyHash
      )
      .run();

    await kv.apiKeys.put(
      `key:${apiKeyHash}`,
      JSON.stringify({ ...TEST_CACHED_API_KEY, projectId: TEST_PROJECT_ID })
    );
  });

  const authHeader = `Bearer ${TEST_API_KEY.raw}`;

  const createCounterparty = (body: Record<string, unknown> = {}) =>
    app.request(
      "/v1/counterparties",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          entityType: "individual",
          displayName: "Alice",
          ...body,
        }),
      },
      env
    );

  describe("GET /v1/counterparties/metadata", () => {
    it("returns field options (enums + countries)", async () => {
      const res = await app.request(
        "/v1/counterparties/metadata",
        { headers: { Authorization: authHeader } },
        env
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: {
          fields: {
            entityTypes: string[];
            countries: { code: string; name: string }[];
            usStates: { code: string; name: string }[];
          };
        };
      };
      expect(body.data.fields.entityTypes).toContain("individual");
      expect(body.data.fields.entityTypes).toContain("business");
      expect(body.data.fields.countries.some((c) => c.code === "US")).toBe(true);
      expect(body.data.fields.usStates.length).toBeGreaterThan(0);
    });
  });

  describe("POST /v1/counterparties", () => {
    it("creates a counterparty", async () => {
      const res = await createCounterparty({ externalId: "ext_001" });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.counterparty.id).toMatch(/^cpty_/);
      expect(body.data.counterparty.organizationId).toBe(TEST_ORG.id);
      expect(body.data.counterparty.entityType).toBe("individual");
      expect(body.data.counterparty.displayName).toBe("Alice");
      expect(body.data.counterparty.externalId).toBe("ext_001");
      expect(body.data.counterparty.status).toBe("active");
      expect(body.data.counterparty.createdBy).toBe(TEST_USER.id);

      const stored = await getDb(env)
        .prepare("SELECT provider_data FROM counterparties WHERE id = ?")
        .bind(body.data.counterparty.id)
        .first<{ provider_data: Record<string, unknown> }>();
      expect(stored?.provider_data).toEqual({});
    });

    it("returns 409 on duplicate externalId", async () => {
      await createCounterparty({ externalId: "dup_001" });
      const res = await createCounterparty({ externalId: "dup_001" });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("CONFLICT");
    });

    it("returns 400 on invalid body", async () => {
      const res = await app.request(
        "/v1/counterparties",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: authHeader },
          body: JSON.stringify({ entityType: "invalid", displayName: "" }),
        },
        env
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("BAD_REQUEST");
    });

    it("returns 401 without auth", async () => {
      const res = await app.request(
        "/v1/counterparties",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entityType: "individual", displayName: "X" }),
        },
        env
      );
      expect(res.status).toBe(401);
    });
  });

  describe("GET /v1/counterparties", () => {
    it("lists counterparties for the org", async () => {
      await createCounterparty({ externalId: "list_1", displayName: "First" });
      await createCounterparty({ externalId: "list_2", displayName: "Second" });

      const res = await app.request(
        "/v1/counterparties",
        { headers: { Authorization: authHeader } },
        env
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.total).toBe(2);
      expect(body.data.counterparties).toHaveLength(2);
      expect(body.data.page).toBe(1);
    });

    it("excludes archived by default", async () => {
      const created = await createCounterparty({ externalId: "archived_1" });
      const cp = (await created.json()).data.counterparty;
      await app.request(
        `/v1/counterparties/${cp.id}`,
        { method: "DELETE", headers: { Authorization: authHeader } },
        env
      );

      const res = await app.request(
        "/v1/counterparties",
        { headers: { Authorization: authHeader } },
        env
      );
      const body = await res.json();
      expect(body.data.total).toBe(0);
    });
  });

  describe("GET /v1/counterparties/:counterpartyId", () => {
    it("returns a counterparty", async () => {
      const created = await createCounterparty({ externalId: "get_1" });
      const cp = (await created.json()).data.counterparty;

      const res = await app.request(
        `/v1/counterparties/${cp.id}`,
        { headers: { Authorization: authHeader } },
        env
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.counterparty.id).toBe(cp.id);
    });

    it("returns 404 for unknown id", async () => {
      const res = await app.request(
        "/v1/counterparties/cpty_does_not_exist",
        { headers: { Authorization: authHeader } },
        env
      );
      expect(res.status).toBe(404);
    });

    it("returns 404 when the counterparty belongs to a different project in the same org", async () => {
      const db = getDb(env);
      const otherProjectId = "prj_counterparties_cross_project";
      const otherCounterpartyId = "cpty_cross_project_iso";

      await db
        .prepare(
          `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, 'Other Project', 'other-project', 'sandbox', 'active', ?)`
        )
        .bind(otherProjectId, TEST_ORG.id, TEST_USER.id)
        .run();

      await db
        .prepare(
          `INSERT INTO counterparties (
             id, organization_id, project_id, external_id, entity_type,
             display_name, provider_data, status, created_by
           ) VALUES (?, ?, ?, ?, 'individual', 'Other Project Alice', '{}', 'active', ?)`
        )
        .bind(otherCounterpartyId, TEST_ORG.id, otherProjectId, "ext_cross_project", TEST_USER.id)
        .run();

      const res = await app.request(
        `/v1/counterparties/${otherCounterpartyId}`,
        { headers: { Authorization: authHeader } },
        env
      );
      expect(res.status).toBe(404);
    });
  });

  describe("GET /v1/counterparties/:counterpartyId/requirements", () => {
    it("surfaces the missing destination wallet for onramp requirements", async () => {
      const created = await createCounterparty();
      const cp = (await created.json()).data.counterparty;

      const res = await app.request(
        `/v1/counterparties/${cp.id}/requirements?provider=moonpay&direction=onramp&cryptoToken=USDC&fiatCurrency=USD`,
        { headers: { Authorization: authHeader } },
        env
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toContain("destinationWallet is required for onramp requirements");
      expect(body.error.details.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["destinationWallet"],
            message: "destinationWallet is required for onramp requirements",
          }),
        ])
      );
    });
  });

  describe("POST /v1/counterparties/:counterpartyId/requirements", () => {
    beforeEach(() => {
      env.LIGHTSPARK_GRID_SANDBOX_CLIENT_ID = "lightspark_client_id";
      env.LIGHTSPARK_GRID_SANDBOX_CLIENT_SECRET = "lightspark_client_secret";
      env.BVNK_SANDBOX_WALLET_ID = "bvnk_wallet_id";
      env.BVNK_SANDBOX_HAWK_AUTH_ID = "bvnk_hawk_auth_id";
      env.BVNK_SANDBOX_HAWK_SECRET_KEY = "bvnk_hawk_secret_key";
    });

    afterEach(() => {
      env.LIGHTSPARK_GRID_SANDBOX_CLIENT_ID = undefined;
      env.LIGHTSPARK_GRID_SANDBOX_CLIENT_SECRET = undefined;
      env.BVNK_SANDBOX_WALLET_ID = undefined;
      env.BVNK_SANDBOX_HAWK_AUTH_ID = undefined;
      env.BVNK_SANDBOX_HAWK_SECRET_KEY = undefined;
    });

    it("returns the missing identity fields when Lightspark has no provider customer", async () => {
      const created = await createCounterparty({ externalId: "requirements_lightspark" });
      expect(created.status).toBe(201);
      const counterparty = (await created.json()).data.counterparty;

      const res = await app.request(
        `/v1/counterparties/${counterparty.id}/requirements`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: authHeader },
          body: JSON.stringify({ provider: "lightspark", direction: "onramp" }),
        },
        env
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe("collect_counterparty");
      expect(body.data.fields.map((field: { key: string }) => field.key)).toEqual([
        "customer.fullName",
        "customer.birthDate",
        "customer.nationality",
        "customer.region",
        "customer.email",
        "customer.address.line1",
        "customer.address.city",
        "customer.address.postalCode",
        "customer.address.countryCode",
      ]);
    });

    it("creates the Grid customer from collected PII and links the provider account", async () => {
      const created = await createCounterparty({ externalId: "requirements_lightspark_pii" });
      expect(created.status).toBe(201);
      const counterparty = (await created.json()).data.counterparty;

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "Customer:cus_new_123" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        })
      );
      try {
        const advanceBody = {
          provider: "lightspark",
          direction: "onramp",
          collectedData: {
            "customer.fullName": "Ada Lovelace",
            "customer.birthDate": "1990-01-01",
            "customer.nationality": "US",
            "customer.region": "US",
            "customer.email": "ada@example.com",
            "customer.address.line1": "1 Main St",
            "customer.address.city": "San Francisco",
            "customer.address.postalCode": "94105",
            "customer.address.countryCode": "US",
          },
        };
        const res = await app.request(
          `/v1/counterparties/${counterparty.id}/requirements`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authHeader },
            body: JSON.stringify(advanceBody),
          },
          env
        );

        expect(res.status).toBe(200);
        expect((await res.json()).data).toEqual({
          provider: "lightspark",
          direction: "onramp",
          status: "ready",
        });
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        const again = await app.request(
          `/v1/counterparties/${counterparty.id}/requirements`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authHeader },
            body: JSON.stringify({ provider: "lightspark", direction: "onramp" }),
          },
          env
        );

        expect(again.status).toBe(200);
        expect((await again.json()).data.status).toBe("ready");
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("fails loudly at the BVNK identity collection seam", async () => {
      const created = await createCounterparty({ externalId: "requirements_bvnk" });
      expect(created.status).toBe(201);
      const counterparty = (await created.json()).data.counterparty;

      const res = await app.request(
        `/v1/counterparties/${counterparty.id}/requirements`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: authHeader },
          body: JSON.stringify({
            provider: "bvnk",
            direction: "onramp",
            cryptoToken: "USDC_SOLANA",
            destinationWallet: "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
            fiatCurrency: "USD",
            collectedData: {
              "taxIdentification.number": "123-45-6789",
              "taxIdentification.taxResidenceCountryCode": "US",
              nationality: "US",
              birthCountryCode: "US",
              "cdd.employmentStatus": "SALARIED",
              "cdd.sourceOfFunds": "SALARY",
              "cdd.pepStatus": "NOT_PEP",
              "cdd.intendedUseOfAccount": "TRANSFERS_OWN_WALLET",
              "cdd.expectedMonthlyVolume.amount": "1000",
              "cdd.estimatedYearlyIncome": "INCOME_100K_TO_250K",
              "cdd.employmentIndustrySector": "INFORMATION",
              "address.stateCode": "CA",
            },
          }),
        },
        env
      );

      expect(res.status).toBe(400);
      expect((await res.json()).error).toEqual({
        code: "BAD_REQUEST",
        message:
          "BVNK onramp requires identity fields that are no longer stored; JIT collection is not wired yet",
      });
    });
  });

  describe("counterparty accounts", () => {
    it("creates, lists, updates, gets, and archives a crypto wallet account", async () => {
      const created = await createCounterparty({ externalId: "account_parent_1" });
      const cp = (await created.json()).data.counterparty;

      const createAccountRes = await app.request(
        `/v1/counterparties/${cp.id}/accounts`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: authHeader },
          body: JSON.stringify({
            accountKind: "crypto_wallet",
            label: "Primary wallet",
            details: {
              network: "solana",
              address: "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
            },
          }),
        },
        env
      );
      expect(createAccountRes.status).toBe(201);
      const account = (await createAccountRes.json()).data.account;
      expect(account.accountKind).toBe("crypto_wallet");
      expect(account.details.network).toBe("solana");

      const listRes = await app.request(
        `/v1/counterparties/${cp.id}/accounts?accountKind=crypto_wallet`,
        { headers: { Authorization: authHeader } },
        env
      );
      expect(listRes.status).toBe(200);
      const listBody = await listRes.json();
      expect(listBody.data.total).toBe(1);

      const updateRes = await app.request(
        `/v1/counterparties/${cp.id}/accounts/${account.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: authHeader },
          body: JSON.stringify({ label: "Updated wallet" }),
        },
        env
      );
      expect(updateRes.status).toBe(200);
      const updated = (await updateRes.json()).data.account;
      expect(updated.label).toBe("Updated wallet");

      const invalidPatchRes = await app.request(
        `/v1/counterparties/${cp.id}/accounts/${account.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: authHeader },
          body: JSON.stringify({
            details: {
              network: "solana",
              address: "not-a-solana-address",
            },
          }),
        },
        env
      );
      expect(invalidPatchRes.status).toBe(400);

      const getRes = await app.request(
        `/v1/counterparties/${cp.id}/accounts/${account.id}`,
        { headers: { Authorization: authHeader } },
        env
      );
      expect(getRes.status).toBe(200);

      const deleteRes = await app.request(
        `/v1/counterparties/${cp.id}/accounts/${account.id}`,
        { method: "DELETE", headers: { Authorization: authHeader } },
        env
      );
      expect(deleteRes.status).toBe(204);
    });

    it("rejects crypto wallet accounts without a Solana wallet address", async () => {
      const created = await createCounterparty({ externalId: "account_parent_invalid" });
      const cp = (await created.json()).data.counterparty;

      const res = await app.request(
        `/v1/counterparties/${cp.id}/accounts`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: authHeader },
          body: JSON.stringify({
            accountKind: "crypto_wallet",
            details: {
              network: "ethereum",
              address: "not-a-solana-address",
            },
          }),
        },
        env
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("BAD_REQUEST");
    });
  });

  describe("PATCH /v1/counterparties/:counterpartyId", () => {
    it("updates displayName", async () => {
      const created = await createCounterparty({ externalId: "patch_1", displayName: "Old" });
      const cp = (await created.json()).data.counterparty;

      const res = await app.request(
        `/v1/counterparties/${cp.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: authHeader },
          body: JSON.stringify({ displayName: "New" }),
        },
        env
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.counterparty.displayName).toBe("New");
    });

    it("returns 409 when changing to an externalId in use by another counterparty", async () => {
      await createCounterparty({ externalId: "taken_1", displayName: "First" });
      const other = await createCounterparty({ externalId: "free_1", displayName: "Second" });
      const otherCp = (await other.json()).data.counterparty;

      const res = await app.request(
        `/v1/counterparties/${otherCp.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: authHeader },
          body: JSON.stringify({ externalId: "taken_1" }),
        },
        env
      );
      expect(res.status).toBe(409);
    });

    it("returns 400 on empty body", async () => {
      const created = await createCounterparty({ externalId: "patch_empty" });
      const cp = (await created.json()).data.counterparty;

      const res = await app.request(
        `/v1/counterparties/${cp.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: authHeader },
          body: JSON.stringify({}),
        },
        env
      );
      expect(res.status).toBe(400);
    });

    it("updates entityType", async () => {
      const created = await createCounterparty({ externalId: "patch_entity_type_only" });
      const cp = (await created.json()).data.counterparty;

      const res = await app.request(
        `/v1/counterparties/${cp.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: authHeader },
          body: JSON.stringify({ entityType: "business" }),
        },
        env
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.counterparty.entityType).toBe("business");
    });
  });

  describe("DELETE /v1/counterparties/:counterpartyId", () => {
    it("archives a counterparty", async () => {
      const created = await createCounterparty({ externalId: "archive_1" });
      const cp = (await created.json()).data.counterparty;

      const res = await app.request(
        `/v1/counterparties/${cp.id}`,
        { method: "DELETE", headers: { Authorization: authHeader } },
        env
      );
      expect(res.status).toBe(204);

      const after = await app.request(
        `/v1/counterparties/${cp.id}`,
        { headers: { Authorization: authHeader } },
        env
      );
      expect(after.status).toBe(404);
    });

    it("returns 404 for unknown id", async () => {
      const res = await app.request(
        "/v1/counterparties/cpty_does_not_exist",
        { method: "DELETE", headers: { Authorization: authHeader } },
        env
      );
      expect(res.status).toBe(404);
    });
  });
});
