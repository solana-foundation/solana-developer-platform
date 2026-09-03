import { createHmac } from "node:crypto";
import { hashString } from "@sdp/payments/hash";
import { bvnkOnrampFields } from "@sdp/payments/ramps/providers/bvnk/counterparty";
import type { ExecutionContext } from "hono";
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
const BVNK_WEBHOOK_SECRET = "bvnk_counterparties_webhook_secret";

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

  async function sendBvnkWebhook(payload: Record<string, unknown>) {
    const body = JSON.stringify({ ...payload, timestamp: new Date().toISOString() });
    const execution: Promise<unknown>[] = [];
    const executionContext: ExecutionContext = {
      waitUntil(promise) {
        execution.push(promise);
      },
      passThroughOnException() {},
      props: {},
    };
    const response = await app.request(
      "/webhooks/payments/ramps/sandbox/bvnk",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature": createHmac("sha256", BVNK_WEBHOOK_SECRET).update(body).digest("base64"),
        },
        body,
      },
      env,
      executionContext
    );
    await Promise.allSettled(execution);
    return response;
  }

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
           provider_customer_reference, kind, external_account_reference, fiat_currency,
           destination_country, payment_rail, provider_status, status, metadata,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`
      )
      .bind(
        input.id,
        TEST_ORG.id,
        TEST_PROJECT_ID,
        input.counterpartyId,
        input.provider,
        input.providerCustomerReference,
        "payout_account",
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
    beforeEach(() => {
      env.LIGHTSPARK_GRID_SANDBOX_CLIENT_ID = "lightspark_client_id";
      env.LIGHTSPARK_GRID_SANDBOX_CLIENT_SECRET = "lightspark_client_secret";
    });

    afterEach(() => {
      env.LIGHTSPARK_GRID_SANDBOX_CLIENT_ID = undefined;
      env.LIGHTSPARK_GRID_SANDBOX_CLIENT_SECRET = undefined;
      vi.restoreAllMocks();
    });

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

    it("returns enriched Lightspark payout accounts in the payout tree", async () => {
      const created = await createCounterparty({ externalId: "requirements_lightspark_accounts" });
      const counterparty = (await created.json()).data.counterparty;
      const providerAccounts = createPostgresCounterpartyProviderAccountsRepository(getDb(env));

      await providerAccounts.upsertProviderAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        provider: "lightspark",
        providerCustomerReference: "Customer:requirements_accounts",
      });
      await getDb(env)
        .prepare("UPDATE counterparties SET provider_data = ? WHERE id = ?")
        .bind(
          JSON.stringify({ lightspark: { purposeOfPayment: "GOODS_OR_SERVICES" } }),
          counterparty.id
        )
        .run();
      await seedProviderAccount({
        id: "provider_account_requirements_ach",
        counterpartyId: counterparty.id,
        provider: "lightspark",
        providerCustomerReference: "Customer:requirements_accounts",
        externalAccountReference: "ExternalAccount:requirements_ach",
        fiatCurrency: "USD",
        destinationCountry: "US",
        paymentRail: "ACH",
        providerStatus: "ACTIVE",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      await seedProviderAccount({
        id: "provider_account_requirements_wire",
        counterpartyId: counterparty.id,
        provider: "lightspark",
        providerCustomerReference: "Customer:requirements_accounts",
        externalAccountReference: "ExternalAccount:requirements_wire",
        fiatCurrency: "USD",
        destinationCountry: "US",
        paymentRail: "WIRE",
        providerStatus: "ACTIVE",
        status: "active",
        createdAt: "2026-01-02T00:00:00.000Z",
      });

      const enrichmentPage = {
        data: [
          {
            platformAccountId: "provider_account_requirements_ach",
            status: "ACTIVE",
            accountInfo: {
              accountType: "USD_ACCOUNT",
              paymentRails: ["ACH"],
              bankName: "ACH Bank",
              accountNumber: "123456789",
            },
          },
          {
            platformAccountId: "provider_account_requirements_wire",
            status: "ACTIVE",
            accountInfo: {
              accountType: "USD_ACCOUNT",
              paymentRails: ["WIRE"],
              bankName: "Wire Bank",
              accountNumber: "987654321",
            },
          },
        ],
        hasMore: false,
      };
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify(enrichmentPage), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        )
      );

      const response = await app.request(
        `/v1/counterparties/${counterparty.id}/requirements?provider=lightspark&direction=offramp&cryptoToken=USDC&fiatCurrency=USD`,
        { headers: { Authorization: authHeader } },
        env
      );

      expect(response.status).toBe(200);
      expect((await response.json()).data.payout.accounts).toEqual([
        {
          id: "provider_account_requirements_ach",
          destinationCountry: "US",
          paymentRail: "ACH",
          status: "ACTIVE",
          bankName: "ACH Bank",
          accountNumberLast4: "6789",
        },
        {
          id: "provider_account_requirements_wire",
          destinationCountry: "US",
          paymentRail: "WIRE",
          status: "ACTIVE",
          bankName: "Wire Bank",
          accountNumberLast4: "4321",
        },
      ]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("returns ready with the active Lightspark corridor account and payout tree", async () => {
      const created = await createCounterparty({ externalId: "requirements_lightspark_reuse" });
      const counterparty = (await created.json()).data.counterparty;
      const providerAccounts = createPostgresCounterpartyProviderAccountsRepository(getDb(env));

      await providerAccounts.upsertProviderAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        provider: "lightspark",
        providerCustomerReference: "Customer:requirements_reuse",
      });
      await getDb(env)
        .prepare("UPDATE counterparties SET provider_data = ? WHERE id = ?")
        .bind(
          JSON.stringify({ lightspark: { purposeOfPayment: "GOODS_OR_SERVICES" } }),
          counterparty.id
        )
        .run();
      await seedProviderAccount({
        id: "provider_account_requirements_reuse",
        counterpartyId: counterparty.id,
        provider: "lightspark",
        providerCustomerReference: "Customer:requirements_reuse",
        externalAccountReference: "ExternalAccount:requirements_reuse",
        fiatCurrency: "USD",
        destinationCountry: "US",
        paymentRail: "ACH",
        providerStatus: "ACTIVE",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      vi.spyOn(globalThis, "fetch").mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              data: [
                {
                  platformAccountId: "provider_account_requirements_reuse",
                  status: "ACTIVE",
                  accountInfo: {
                    accountType: "USD_ACCOUNT",
                    paymentRails: ["ACH"],
                    bankName: "Reuse Bank",
                    accountNumber: "123456789",
                  },
                },
              ],
              hasMore: false,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        )
      );

      const response = await app.request(
        `/v1/counterparties/${counterparty.id}/requirements?provider=lightspark&direction=offramp&cryptoToken=USDC&fiatCurrency=USD&destinationCountry=US`,
        { headers: { Authorization: authHeader } },
        env
      );

      expect(response.status).toBe(200);
      expect((await response.json()).data).toEqual(
        expect.objectContaining({
          provider: "lightspark",
          direction: "offramp",
          status: "ready",
          providerAccountId: "provider_account_requirements_reuse",
          payout: expect.objectContaining({
            accounts: [
              {
                id: "provider_account_requirements_reuse",
                destinationCountry: "US",
                paymentRail: "ACH",
                status: "ACTIVE",
                bankName: "Reuse Bank",
                accountNumberLast4: "6789",
              },
            ],
          }),
        })
      );
    });

    it("rejects an invalid Lightspark off-ramp destination country", async () => {
      const response = await app.request(
        "/v1/counterparties/cp_invalid_country/requirements?provider=lightspark&direction=offramp&cryptoToken=USDC&fiatCurrency=USD&destinationCountry=USA",
        { headers: { Authorization: authHeader } },
        env
      );

      expect(response.status).toBe(400);
    });

    it("rejects destinationCountry for non-Lightspark off-ramp requirements", async () => {
      const response = await app.request(
        "/v1/counterparties/cp_bvnk_country/requirements?provider=bvnk&direction=offramp&cryptoToken=USDC&fiatCurrency=USD&destinationCountry=US",
        { headers: { Authorization: authHeader } },
        env
      );

      expect(response.status).toBe(400);
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

    it("returns ready with the resolved payout account id for an offramp advance", async () => {
      const created = await createCounterparty({ externalId: "requirements_offramp_ready" });
      expect(created.status).toBe(201);
      const counterparty = (await created.json()).data.counterparty;
      const repository = createPostgresCounterpartyProviderAccountsRepository(getDb(env));
      await repository.upsertProviderAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        provider: "lightspark",
        providerCustomerReference: "Customer:cus_offramp_ready",
      });
      await seedProviderAccount({
        id: "provider_account_offramp_ready",
        counterpartyId: counterparty.id,
        provider: "lightspark",
        providerCustomerReference: "Customer:cus_offramp_ready",
        externalAccountReference: "ExternalAccount:offramp_ready",
        fiatCurrency: "USD",
        destinationCountry: "US",
        paymentRail: "ACH",
        providerStatus: "ACTIVE",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const res = await app.request(
        `/v1/counterparties/${counterparty.id}/requirements`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: authHeader },
          body: JSON.stringify({
            provider: "lightspark",
            direction: "offramp",
            cryptoToken: "USDC",
            fiatCurrency: "USD",
            collectedData: { destinationCountry: "US", purposeOfPayment: "SELF" },
          }),
        },
        env
      );

      expect(res.status).toBe(200);
      expect((await res.json()).data).toEqual({
        provider: "lightspark",
        direction: "offramp",
        status: "ready",
        providerAccountId: "provider_account_offramp_ready",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("rejects invalid new-account bank fields without persisting a pending account row", async () => {
      const created = await createCounterparty({ externalId: "requirements_invalid_bank" });
      expect(created.status).toBe(201);
      const counterparty = (await created.json()).data.counterparty;
      const repository = createPostgresCounterpartyProviderAccountsRepository(getDb(env));
      await repository.upsertProviderAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        provider: "lightspark",
        providerCustomerReference: "Customer:cus_invalid_bank",
      });
      await seedProviderAccount({
        id: "provider_account_stale_reservation",
        counterpartyId: counterparty.id,
        provider: "lightspark",
        providerCustomerReference: "Customer:cus_invalid_bank",
        externalAccountReference: null,
        fiatCurrency: "USD",
        destinationCountry: "US",
        paymentRail: "ACH",
        providerStatus: null,
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      const res = await app.request(
        `/v1/counterparties/${counterparty.id}/requirements`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: authHeader },
          body: JSON.stringify({
            provider: "lightspark",
            direction: "offramp",
            cryptoToken: "USDC",
            fiatCurrency: "USD",
            collectedData: {
              destinationCountry: "US",
              paymentRails: "ACH",
              purposeOfPayment: "SELF",
            },
          }),
        },
        env
      );

      expect(res.status).toBe(400);
      const pendingRows = await getDb(env)
        .prepare(
          `SELECT id, status FROM counterparty_provider_accounts
           WHERE counterparty_id = ? AND payment_rail IS NOT NULL
             AND external_account_reference IS NULL`
        )
        .bind(counterparty.id)
        .all<{ id: string; status: string }>();
      expect(pendingRows.results).toEqual([
        { id: "provider_account_stale_reservation", status: "active" },
      ]);
    });

    it("rejects a providerAccountId owned by another counterparty on the advance", async () => {
      const created = await createCounterparty({ externalId: "requirements_foreign_owner" });
      expect(created.status).toBe(201);
      const counterparty = (await created.json()).data.counterparty;
      const other = await createCounterparty({ externalId: "requirements_foreign_other" });
      expect(other.status).toBe(201);
      const otherCounterparty = (await other.json()).data.counterparty;
      const repository = createPostgresCounterpartyProviderAccountsRepository(getDb(env));
      await repository.upsertProviderAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        provider: "lightspark",
        providerCustomerReference: "Customer:cus_foreign_owner",
      });
      await seedProviderAccount({
        id: "provider_account_foreign_owned",
        counterpartyId: otherCounterparty.id,
        provider: "lightspark",
        providerCustomerReference: "Customer:cus_foreign_other",
        externalAccountReference: "ExternalAccount:foreign_owned",
        fiatCurrency: "USD",
        destinationCountry: "US",
        paymentRail: "ACH",
        providerStatus: "ACTIVE",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      const res = await app.request(
        `/v1/counterparties/${counterparty.id}/requirements`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: authHeader },
          body: JSON.stringify({
            provider: "lightspark",
            direction: "offramp",
            cryptoToken: "USDC",
            fiatCurrency: "USD",
            providerAccountId: "provider_account_foreign_owned",
            collectedData: { destinationCountry: "US", purposeOfPayment: "SELF" },
          }),
        },
        env
      );

      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toContain("providerAccountId");
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

    it("returns BVNK identity requirements for a fresh counterparty", async () => {
      const created = await createCounterparty({ externalId: "requirements_bvnk" });
      expect(created.status).toBe(201);
      const counterparty = (await created.json()).data.counterparty;

      const res = await app.request(
        `/v1/counterparties/${counterparty.id}/requirements?provider=bvnk&direction=onramp&cryptoToken=USDC_SOLANA&fiatCurrency=USD&destinationWallet=8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ`,
        {
          headers: { "Content-Type": "application/json", Authorization: authHeader },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual({
        provider: "bvnk",
        direction: "onramp",
        status: "collect_counterparty",
        fields: bvnkOnrampFields(),
      });
    });

    it("returns JIT agreement content without creating or persisting a customer", async () => {
      const created = await createCounterparty({ externalId: "requirements_bvnk_agreements" });
      const counterparty = (await created.json()).data.counterparty;
      const agreementId = "agreement_1";
      const collectedData = {
        firstName: "Ada",
        lastName: "Lovelace",
        dateOfBirth: "1815-12-10",
        email: "ada@example.com",
        "address.addressLine1": "1 Main Street",
        "address.city": "Austin",
        "address.postalCode": "78701",
        "address.countryCode": "US",
        "address.stateCode": "TX",
        "taxIdentification.number": "123-45-6789",
        "taxIdentification.taxResidenceCountryCode": "US",
        birthCountryCode: "GB",
        "cdd.employmentStatus": "SALARIED",
        "cdd.sourceOfFunds": "SALARY",
        "cdd.pepStatus": "NOT_PEP",
        "cdd.intendedUseOfAccount": "TRANSFERS_OWN_WALLET",
        "cdd.expectedMonthlyVolume.amount": "1000",
        "cdd.expectedMonthlyVolume.currency": "USD",
        "cdd.estimatedYearlyIncome": "INCOME_100K_TO_250K",
        "cdd.employmentIndustrySector": "INFORMATION",
      };
      const requests: string[] = [];
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const path = new URL(String(input)).pathname;
        requests.push(path);
        if (path === "/platform/v2/agreements") {
          return new Response(
            JSON.stringify({
              id: "working-set-1",
              reference: "reference",
              agreements: [
                { id: agreementId, status: "PENDING", declinable: false, name: "Terms" },
              ],
              signingUrl: "https://example.invalid/sign",
            }),
            { status: 201, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(
          JSON.stringify({
            downloadUrl: "https://example.invalid/terms.pdf",
            filename: "terms.pdf",
            expiresAt: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      });
      env.BVNK_SANDBOX_WALLET_ID = "wallet";
      env.BVNK_SANDBOX_HAWK_AUTH_ID = "auth";
      env.BVNK_SANDBOX_HAWK_SECRET_KEY = "secret";
      try {
        const response = await app.request(
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
              collectedData,
            }),
          },
          env
        );
        expect(response.status).toBe(200);
        expect((await response.json()).data).toEqual({
          provider: "bvnk",
          direction: "onramp",
          status: "customer_agreement_required",
          agreements: [
            {
              id: agreementId,
              filename: "terms.pdf",
              downloadUrl: "https://example.invalid/terms.pdf",
            },
          ],
        });
        expect(requests).toEqual([
          "/platform/v2/agreements",
          `/platform/v2/agreements/${agreementId}/content`,
        ]);
        const row = await getDb(env)
          .prepare(
            `SELECT provider_customer_reference, metadata FROM counterparty_provider_accounts
             WHERE counterparty_id = ? AND provider = 'bvnk' AND kind = 'customer_link'`
          )
          .bind(counterparty.id)
          .first();
        expect(row).toBeNull();
        const counterpartyRow = await getDb(env)
          .prepare("SELECT provider_data FROM counterparties WHERE id = ?")
          .bind(counterparty.id)
          .first<{ provider_data: Record<string, unknown> }>();
        expect(JSON.stringify(counterpartyRow?.provider_data)).not.toContain("terms.pdf");
        expect(JSON.stringify(counterpartyRow?.provider_data)).not.toContain("example.invalid");
      } finally {
        fetchSpy.mockRestore();
        env.BVNK_SANDBOX_WALLET_ID = undefined;
        env.BVNK_SANDBOX_HAWK_AUTH_ID = undefined;
        env.BVNK_SANDBOX_HAWK_SECRET_KEY = undefined;
      }
    });

    it("does not create a customer when agreement confirmation remains pending", async () => {
      const created = await createCounterparty({
        externalId: "requirements_bvnk_pending_confirmation",
      });
      const counterparty = (await created.json()).data.counterparty;
      const collectedData = {
        firstName: "Ada",
        lastName: "Lovelace",
        dateOfBirth: "1815-12-10",
        email: "ada@example.com",
        "address.addressLine1": "1 Main Street",
        "address.city": "Austin",
        "address.postalCode": "78701",
        "address.countryCode": "US",
        "address.stateCode": "TX",
        "taxIdentification.number": "123-45-6789",
        "taxIdentification.taxResidenceCountryCode": "US",
        birthCountryCode: "GB",
        "cdd.employmentStatus": "SALARIED",
        "cdd.sourceOfFunds": "SALARY",
        "cdd.pepStatus": "NOT_PEP",
        "cdd.intendedUseOfAccount": "TRANSFERS_OWN_WALLET",
        "cdd.expectedMonthlyVolume.amount": "1000",
        "cdd.expectedMonthlyVolume.currency": "USD",
        "cdd.estimatedYearlyIncome": "INCOME_100K_TO_250K",
        "cdd.employmentIndustrySector": "INFORMATION",
      };
      const requests: string[] = [];
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, _init) => {
        const path = new URL(String(input)).pathname;
        requests.push(path);
        if (path === "/platform/v2/agreements") {
          return new Response(
            JSON.stringify({
              id: "working-set-pending",
              reference: "reference",
              agreements: [{ id: "agreement-pending", status: "PENDING", declinable: false }],
              signingUrl: "https://example.invalid/sign",
            }),
            { status: 201, headers: { "Content-Type": "application/json" } }
          );
        }
        if (path === "/platform/v2/agreements/actions") {
          return new Response(
            JSON.stringify({
              content: [{ agreementId: "agreement-pending" }],
              totalElements: 1,
              totalPages: 1,
              hasNext: false,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (path === "/platform/v2/agreements/agreement-pending/content") {
          return new Response(
            JSON.stringify({
              downloadUrl: "https://example.invalid/pending.pdf",
              filename: "terms.pdf",
              expiresAt: null,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        throw new Error(`Unexpected BVNK request ${path}`);
      });
      env.BVNK_SANDBOX_WALLET_ID = "wallet";
      env.BVNK_SANDBOX_HAWK_AUTH_ID = "auth";
      env.BVNK_SANDBOX_HAWK_SECRET_KEY = "secret";
      try {
        const response = await app.request(
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
              collectedData,
              agreementConsent: true,
            }),
          },
          env
        );
        expect(response.status).toBe(200);
        expect((await response.json()).data.status).toBe("customer_pending_agreement_acceptance");
        expect(requests).toEqual(["/platform/v2/agreements", "/platform/v2/agreements/actions"]);
        expect(requests).not.toContain("/platform/v3/contacts");
        expect(requests).not.toContain("/platform/v2/customers");
        const row = await getDb(env)
          .prepare(
            `SELECT provider_customer_reference, metadata FROM counterparty_provider_accounts
             WHERE counterparty_id = ? AND provider = 'bvnk' AND kind = 'customer_link'`
          )
          .bind(counterparty.id)
          .first<{ provider_customer_reference: string; metadata: Record<string, unknown> }>();
        expect(row).toMatchObject({
          provider_customer_reference: "working-set-pending",
          metadata: {
            agreements: {
              relayedAt: expect.any(String),
              entries: { "agreement-pending": { status: "PENDING" } },
            },
          },
        });
      } finally {
        fetchSpy.mockRestore();
        env.BVNK_SANDBOX_WALLET_ID = undefined;
        env.BVNK_SANDBOX_HAWK_AUTH_ID = undefined;
        env.BVNK_SANDBOX_HAWK_SECRET_KEY = undefined;
      }
    });

    it("creates a customer on a later advance after agreement confirmation", async () => {
      const created = await createCounterparty({ externalId: "requirements_bvnk_confirmed" });
      const counterparty = (await created.json()).data.counterparty;
      const collectedData = {
        firstName: "Ada",
        lastName: "Lovelace",
        dateOfBirth: "1815-12-10",
        email: "ada@example.com",
        "address.addressLine1": "1 Main Street",
        "address.city": "Austin",
        "address.postalCode": "78701",
        "address.countryCode": "US",
        "address.stateCode": "TX",
        "taxIdentification.number": "123-45-6789",
        "taxIdentification.taxResidenceCountryCode": "US",
        birthCountryCode: "GB",
        "cdd.employmentStatus": "SALARIED",
        "cdd.sourceOfFunds": "SALARY",
        "cdd.pepStatus": "NOT_PEP",
        "cdd.intendedUseOfAccount": "TRANSFERS_OWN_WALLET",
        "cdd.expectedMonthlyVolume.amount": "1000",
        "cdd.expectedMonthlyVolume.currency": "USD",
        "cdd.estimatedYearlyIncome": "INCOME_100K_TO_250K",
        "cdd.employmentIndustrySector": "INFORMATION",
      };
      const repository = createPostgresCounterpartyProviderAccountsRepository(getDb(env));
      await repository.upsertProviderAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        provider: "bvnk",
        providerCustomerReference: "working-set-confirmed",
        metadata: {
          agreements: {
            relayedAt: "2026-08-01T00:00:00.000Z",
            entries: {
              "agreement-confirmed": { status: "PENDING" },
              "agreement-confirmed-2": { status: "PENDING" },
            },
          },
        },
      });
      const before = await repository.getProviderAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        provider: "bvnk",
      });
      if (!before) throw new Error("Expected BVNK customer-link row");
      const requests: string[] = [];
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const path = new URL(String(input)).pathname;
        requests.push(path);
        if (path === "/platform/v3/contacts") {
          return new Response(JSON.stringify({ contactId: "contact-confirmed" }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (path === "/platform/v2/customers") {
          return new Response(
            JSON.stringify({
              id: "working-set-confirmed",
              reference: "reference",
              status: "PENDING",
              type: "INDIVIDUAL",
              model: "EMBEDDED_BVNK_MANAGED",
              useCase: "FIAT",
            }),
            { status: 201, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(
          JSON.stringify({
            id: "working-set-confirmed",
            reference: "reference",
            status: "PENDING",
            type: "INDIVIDUAL",
            model: "EMBEDDED_BVNK_MANAGED",
            useCase: "FIAT",
            authenticatedLink: {
              link: "https://example.invalid/verify",
              expiresAt: "2030-01-01T00:00:00Z",
            },
            requiredActions: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      });
      env.BVNK_SANDBOX_WALLET_ID = "wallet";
      env.BVNK_SANDBOX_HAWK_AUTH_ID = "auth";
      env.BVNK_SANDBOX_HAWK_SECRET_KEY = "secret";
      env.BVNK_SANDBOX_WEBHOOK_SECRET = BVNK_WEBHOOK_SECRET;
      try {
        expect(
          (
            await sendBvnkWebhook({
              event: "bvnk:customers:agreements:status-change",
              data: {
                customerId: "working-set-confirmed",
                agreementId: "agreement-confirmed",
                status: "ACCEPTED",
              },
            })
          ).status
        ).toBe(200);
        expect(
          (
            await sendBvnkWebhook({
              event: "bvnk:customers:agreements:status-change",
              data: {
                customerId: "working-set-confirmed",
                agreementId: "agreement-confirmed-2",
                status: "ACCEPTED",
              },
            })
          ).status
        ).toBe(200);

        const requirements = await app.request(
          `/v1/counterparties/${counterparty.id}/requirements?provider=bvnk&direction=onramp&cryptoToken=USDC_SOLANA&fiatCurrency=USD&destinationWallet=8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ`,
          { headers: { "Content-Type": "application/json", Authorization: authHeader } },
          env
        );
        expect(requirements.status).toBe(200);
        expect((await requirements.json()).data.status).toBe("collect_counterparty");
        expect(requests).toEqual([]);

        const response = await app.request(
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
              collectedData,
            }),
          },
          env
        );
        expect(response.status).toBe(200);
        expect((await response.json()).data.status).toBe("customer_verifying");
        expect(requests).toEqual([
          "/platform/v3/contacts",
          "/platform/v2/customers",
          "/platform/v2/customers/working-set-confirmed",
        ]);
        const after = await repository.getProviderAccount({
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT_ID,
          counterpartyId: counterparty.id,
          provider: "bvnk",
        });
        expect(after?.id).toBe(before.id);
        expect(after?.provider_customer_reference).toBe("working-set-confirmed");
        expect(after?.metadata).toMatchObject({
          status: "PENDING",
          contactId: "contact-confirmed",
          agreements: {
            relayedAt: "2026-08-01T00:00:00.000Z",
            entries: {
              "agreement-confirmed": { status: "ACCEPTED" },
              "agreement-confirmed-2": { status: "ACCEPTED" },
            },
          },
        });
      } finally {
        fetchSpy.mockRestore();
        env.BVNK_SANDBOX_WALLET_ID = undefined;
        env.BVNK_SANDBOX_HAWK_AUTH_ID = undefined;
        env.BVNK_SANDBOX_HAWK_SECRET_KEY = undefined;
        env.BVNK_SANDBOX_WEBHOOK_SECRET = undefined;
      }
    });

    it("re-derives agreement requirements when metadata records a revoked agreement", async () => {
      const created = await createCounterparty({ externalId: "requirements_bvnk_revoked" });
      const counterparty = (await created.json()).data.counterparty;
      const repository = createPostgresCounterpartyProviderAccountsRepository(getDb(env));
      await repository.upsertProviderAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        provider: "bvnk",
        providerCustomerReference: "customer-revoked",
        metadata: {
          status: "VERIFIED",
          agreements: {
            relayedAt: "2026-08-01T00:00:00.000Z",
            entries: { "agreement-revoked": { status: "ACCEPTED" } },
          },
        },
      });
      const paths: string[] = [];
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        return new Response(
          JSON.stringify({
            downloadUrl: "https://example.invalid/revoked.pdf",
            filename: "terms.pdf",
            expiresAt: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      });
      env.BVNK_SANDBOX_WEBHOOK_SECRET = BVNK_WEBHOOK_SECRET;
      try {
        expect(
          (
            await sendBvnkWebhook({
              event: "bvnk:customers:agreements:status-change",
              data: {
                customerId: "customer-revoked",
                agreementId: "agreement-revoked",
                status: "PENDING",
              },
            })
          ).status
        ).toBe(200);
        const response = await app.request(
          `/v1/counterparties/${counterparty.id}/requirements?provider=bvnk&direction=onramp&cryptoToken=USDC_SOLANA&fiatCurrency=USD&destinationWallet=8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ`,
          { headers: { "Content-Type": "application/json", Authorization: authHeader } },
          env
        );
        expect(response.status).toBe(200);
        expect((await response.json()).data.status).toBe("customer_agreement_required");
        expect(paths).toEqual(["/platform/v2/agreements/agreement-revoked/content"]);

        expect(
          (
            await sendBvnkWebhook({
              event: "bvnk:customers:agreements:status-change",
              data: {
                customerId: "customer-revoked",
                agreementId: "agreement-revoked",
                status: "REJECTED",
              },
            })
          ).status
        ).toBe(200);
        const rejected = await app.request(
          `/v1/counterparties/${counterparty.id}/requirements?provider=bvnk&direction=onramp&cryptoToken=USDC_SOLANA&fiatCurrency=USD&destinationWallet=8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ`,
          { headers: { "Content-Type": "application/json", Authorization: authHeader } },
          env
        );
        expect(rejected.status).toBe(200);
        expect((await rejected.json()).data).toEqual({
          provider: "bvnk",
          direction: "onramp",
          status: "customer_agreement_required",
          agreements: [
            {
              id: "agreement-revoked",
              filename: "terms.pdf",
              downloadUrl: "https://example.invalid/revoked.pdf",
            },
          ],
        });
        expect(paths).toEqual([
          "/platform/v2/agreements/agreement-revoked/content",
          "/platform/v2/agreements/agreement-revoked/content",
        ]);
      } finally {
        fetchSpy.mockRestore();
        env.BVNK_SANDBOX_WEBHOOK_SECRET = undefined;
      }
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
            kind: "payout_account",
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
            kind: "payout_account",
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
            kind: "payout_account",
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
