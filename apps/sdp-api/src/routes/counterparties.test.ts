import { hashString } from "@sdp/payments/hash";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories";
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

  /**
   * Inserts one provider-account fixture with explicit timestamps.
   *
   * @param input - Provider-account fixture values.
   * @returns The inserted provider-account row.
   */
  async function seedProviderAccount(input: {
    id: string;
    counterpartyId: string;
    provider: "lightspark" | "mural";
    providerCustomerReference: string;
    externalAccountReference: string | null;
    fiatCurrency: string;
    destinationCountry: "US" | "GB";
    paymentRail: string;
    providerStatus: string | null;
    status: "active" | "archived";
    createdAt: string;
  }) {
    const row = await getDb(env)
      .prepare(
        `INSERT INTO counterparty_provider_accounts (
           id, organization_id, project_id, counterparty_id, provider,
           provider_customer_reference, external_account_reference, fiat_currency,
           destination_country, payment_rail, provider_status, status, metadata,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`
      )
      .bind(
        input.id,
        TEST_ORG.id,
        TEST_PROJECT_ID,
        input.counterpartyId,
        input.provider,
        input.providerCustomerReference,
        input.externalAccountReference,
        input.fiatCurrency,
        input.destinationCountry,
        input.paymentRail,
        input.providerStatus,
        input.status,
        JSON.stringify({}),
        input.createdAt,
        input.createdAt
      )
      .first<Record<string, unknown>>();
    expect(row).not.toBeNull();
    const repository = createPostgresCounterpartyProviderAccountsRepository(getDb(env));
    const inserted = await repository.listProviderAccounts({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: input.counterpartyId,
    });
    const result = inserted.find((candidate) => candidate.id === input.id);
    expect(result).toBeDefined();
    if (result === undefined) {
      throw new Error("Provider-account fixture was not inserted");
    }
    return result;
  }

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
          };
        };
      };
      expect(body.data.fields.entityTypes).toContain("individual");
      expect(body.data.fields.entityTypes).toContain("business");
      expect(body.data.fields.countries.some((c) => c.code === "US")).toBe(true);
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
        "purposeOfPayment",
      ]);
      expect(body.data.fields[2]).toEqual({
        kind: "country",
        key: "customer.nationality",
        label: "Nationality",
        required: true,
      });
      expect(body.data.fields[3]).toEqual({
        kind: "country",
        key: "customer.region",
        label: "Region",
        required: true,
      });
      expect(body.data.fields[8]).toEqual({
        kind: "country",
        key: "customer.address.countryCode",
        label: "Country",
        required: true,
      });
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
            purposeOfPayment: "GOODS_OR_SERVICES",
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

  describe("GET /v1/counterparties/:counterpartyId/provider-accounts", () => {
    beforeEach(() => {
      env.LIGHTSPARK_GRID_SANDBOX_CLIENT_ID = "lightspark_client_id";
      env.LIGHTSPARK_GRID_SANDBOX_CLIENT_SECRET = "lightspark_client_secret";
    });

    afterEach(() => {
      env.LIGHTSPARK_GRID_SANDBOX_CLIENT_ID = undefined;
      env.LIGHTSPARK_GRID_SANDBOX_CLIENT_SECRET = undefined;
      vi.restoreAllMocks();
    });

    it("lists scoped rows with grouped JIT enrichment, filters, and pending rows", async () => {
      const created = await createCounterparty({ externalId: "provider_accounts_owner" });
      const owner = (await created.json()).data.counterparty;
      const otherCreated = await createCounterparty({ externalId: "provider_accounts_other" });
      const other = (await otherCreated.json()).data.counterparty;

      await seedProviderAccount({
        id: "provider_account_usd_completed",
        counterpartyId: owner.id,
        provider: "lightspark",
        providerCustomerReference: "Customer:owner",
        externalAccountReference: "ExternalAccount:usd_completed",
        fiatCurrency: "USD",
        destinationCountry: "US",
        paymentRail: "ACH",
        providerStatus: "PENDING",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      await seedProviderAccount({
        id: "provider_account_usd_pending",
        counterpartyId: owner.id,
        provider: "lightspark",
        providerCustomerReference: "Customer:owner",
        externalAccountReference: null,
        fiatCurrency: "USD",
        destinationCountry: "US",
        paymentRail: "WIRE",
        providerStatus: null,
        status: "active",
        createdAt: "2026-01-02T00:00:00.000Z",
      });
      await seedProviderAccount({
        id: "provider_account_gbp_archived",
        counterpartyId: owner.id,
        provider: "mural",
        providerCustomerReference: "mural_customer",
        externalAccountReference: "mural_external",
        fiatCurrency: "GBP",
        destinationCountry: "GB",
        paymentRail: "FPS",
        providerStatus: "ACTIVE",
        status: "archived",
        createdAt: "2026-01-03T00:00:00.000Z",
      });
      await seedProviderAccount({
        id: "provider_account_other_counterparty",
        counterpartyId: other.id,
        provider: "lightspark",
        providerCustomerReference: "Customer:owner",
        externalAccountReference: "ExternalAccount:other",
        fiatCurrency: "USD",
        destinationCountry: "US",
        paymentRail: "ACH",
        providerStatus: "ACTIVE",
        status: "active",
        createdAt: "2026-01-04T00:00:00.000Z",
      });

      const enrichmentPage = JSON.stringify({
        data: [
          {
            platformAccountId: "provider_account_usd_completed",
            status: "ACTIVE",
            accountInfo: {
              accountType: "USD_ACCOUNT",
              paymentRails: ["ACH", "WIRE"],
              bankName: "Example Bank",
              accountNumber: "123456789",
            },
          },
          {
            platformAccountId: "provider_account_usd_pending",
            status: "ACTIVE",
            accountInfo: {
              accountType: "USD_ACCOUNT",
              paymentRails: ["ACH"],
              bankName: "Should Stay Absent",
              accountNumber: "999999999",
            },
          },
        ],
        hasMore: false,
      });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
        Promise.resolve(
          new Response(enrichmentPage, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        )
      );

      const response = await app.request(
        `/v1/counterparties/${owner.id}/provider-accounts`,
        { headers: { Authorization: authHeader } },
        env
      );

      expect(response.status).toBe(200);
      expect((await response.json()).data).toEqual({
        accounts: [
          {
            id: "provider_account_usd_completed",
            provider: "lightspark",
            fiatCurrency: "USD",
            destinationCountry: "US",
            paymentRail: "ACH",
            status: "active",
            providerStatus: "ACTIVE",
            createdAt: "2026-01-01T00:00:00.000Z",
            bankName: "Example Bank",
            accountNumberLast4: "6789",
            paymentRails: ["ACH", "WIRE"],
          },
          {
            id: "provider_account_usd_pending",
            provider: "lightspark",
            fiatCurrency: "USD",
            destinationCountry: "US",
            paymentRail: "WIRE",
            status: "active",
            providerStatus: null,
            createdAt: "2026-01-02T00:00:00.000Z",
          },
          {
            id: "provider_account_gbp_archived",
            provider: "mural",
            fiatCurrency: "GBP",
            destinationCountry: "GB",
            paymentRail: "FPS",
            status: "archived",
            providerStatus: "ACTIVE",
            createdAt: "2026-01-03T00:00:00.000Z",
          },
        ],
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const requestUrl = new URL(String(fetchSpy.mock.calls[0][0]));
      expect(requestUrl.searchParams.get("customerId")).toBe("Customer:owner");
      expect(requestUrl.searchParams.get("currency")).toBe("USD");

      const filtered = await app.request(
        `/v1/counterparties/${owner.id}/provider-accounts?provider=lightspark&fiatCurrency=USD&destinationCountry=US`,
        { headers: { Authorization: authHeader } },
        env
      );
      expect(filtered.status).toBe(200);
      const filteredBody = await filtered.json();
      expect(filteredBody.data.accounts.map((account: { id: string }) => account.id)).toEqual([
        "provider_account_usd_completed",
        "provider_account_usd_pending",
      ]);
    });

    it("returns 503 when Grid enrichment fails", async () => {
      const created = await createCounterparty({ externalId: "provider_accounts_failure" });
      const owner = (await created.json()).data.counterparty;
      await seedProviderAccount({
        id: "provider_account_failure",
        counterpartyId: owner.id,
        provider: "lightspark",
        providerCustomerReference: "Customer:failure",
        externalAccountReference: "ExternalAccount:failure",
        fiatCurrency: "USD",
        destinationCountry: "US",
        paymentRail: "ACH",
        providerStatus: "PENDING",
        status: "active",
        createdAt: "2026-02-01T00:00:00.000Z",
      });
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ message: "Grid unavailable" }), { status: 503 })
      );

      const response = await app.request(
        `/v1/counterparties/${owner.id}/provider-accounts`,
        { headers: { Authorization: authHeader } },
        env
      );

      expect(response.status).toBe(503);
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
