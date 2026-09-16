import { hashString } from "@sdp/payments/hash";
import { buildBvnkCustomerRequest } from "@sdp/payments/ramps/providers/bvnk/counterparty";
import { buildBvnkCustomerExternalReference } from "@sdp/payments/ramps/providers/bvnk/provider-data";
import {
  BVNK_RESIDENCE_FIELDS,
  BVNK_US_MTL_STATES,
  bvnkOnrampFields,
} from "@sdp/payments/ramps/providers/bvnk/requirements";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories";
import app from "@/index";
import { createKVStoreSet } from "@/runtime/kv-redis";
import {
  TEST_API_KEY,
  TEST_CACHED_API_KEY,
  TEST_PRODUCTION_API_KEY,
} from "@/test/fixtures/api-keys";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { seedProjectApiKey } from "@/test/helpers/api-keys";
import { seedTestCustodySetup } from "@/test/helpers/custody";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

const TEST_PROJECT_ID = "prj_counterparties_test";
const TEST_CP_CUSTODY_WALLET_ID = "cwlt_counterparties_test";
const TEST_CP_CUSTODY_CONFIG_ID = "ccfg_counterparties_test";
const TEST_CP_WALLET_PUBLIC_KEY = "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ";

const BVNK_SESSION_REFERENCE = "c1d91c8b-f4a6-469e-953d-7344fdb6858c";
const BVNK_CUSTOMER_REFERENCE = "2a9c8a29-5030-456d-87c2-7f6cc2ee6bf3";
const BVNK_SESSION_AGREEMENT = {
  status: "PENDING",
  name: "EMBEDDED_PARTNER_PLATFORM_CUSTOMERS_US",
  displayName: "Embedded US Partner Platform Customers Agreement",
  description: "Embedded US Partner Platform Customers Agreement",
  url: "https://help.bvnk.com/hc/en-us/sections/27816998470930-BVNK-US-Partner-Platform-Customers",
  privacyPolicyName: "End customer Privacy Policy",
  privacyPolicyDescription:
    "Privacy Policy describes our data handling practices when you access content we own or operate on the website located at www.bvnk.com or any other associated websites we own or operate",
  privacyPolicyUrl: "https://help.bvnk.com/hc/en-us/articles/7662076884882-Privacy-Policy",
} as const;
const BVNK_STORED_AGREEMENT = {
  name: BVNK_SESSION_AGREEMENT.name,
  displayName: BVNK_SESSION_AGREEMENT.displayName,
  description: BVNK_SESSION_AGREEMENT.description,
  url: BVNK_SESSION_AGREEMENT.url,
  privacyPolicyUrl: BVNK_SESSION_AGREEMENT.privacyPolicyUrl,
} as const;
const BVNK_CUSTOMER_DETAIL = {
  reference: BVNK_CUSTOMER_REFERENCE,
  externalReference: "probe_v1_1789564047204",
  status: "INFO_REQUIRED",
  type: "INDIVIDUAL",
  flowType: "API",
  individual: {
    person: {
      reference: "6273b651-74c1-47c2-84d4-0052238a6232",
      firstName: "Jane",
      lastName: "Doe",
      dateOfBirth: "1984-06-30",
      address: {
        addressLine1: "1 Main Street",
        city: "Austin",
        postalCode: "78701",
        stateCode: "TX",
        state: "Texas",
        countryCode: "US",
        country: "United States",
      },
    },
    details: {
      nationality: "US",
      birthCountryCode: "US",
      contactInfo: { emailAddress: "probe+178****5742@example.com" },
      taxIdentification: { number: "123-45-6789", taxResidenceCountryCode: "US" },
    },
    cdd: {
      intendedUseOfAccount: "TRANSFERS_OWN_WALLET",
      pepStatus: "NOT_PEP",
      expectedMonthlyVolume: { amount: 1000, currency: "USD" },
      employmentStatus: "SALARIED",
      sourceOfFunds: "SALARY",
      estimatedYearlyIncome: "INCOME_0_TO_50K",
      employmentIndustrySector: "INVESTMENT",
    },
  },
  verification: {
    status: "init",
    url: "https://in.sumsub.com/websdk/p/sbx_EDHeJPPmWnBSU2Es",
    expiresAt: "2026-10-16T13:07:54.354482408Z",
  },
} as const;

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

    await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [TEST_USER.id],
      ids: { sandbox: TEST_PROJECT_ID, production: `${TEST_PROJECT_ID}_production` },
    });
    await seedProjectApiKey(db, env, {
      key: TEST_PRODUCTION_API_KEY,
      organizationId: TEST_ORG.id,
      projectId: `${TEST_PROJECT_ID}_production`,
      createdBy: TEST_USER.id,
      role: "api_admin",
      permissions: ["*"],
    });

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

    const seededAt = new Date().toISOString();
    await seedTestCustodySetup(
      env,
      {
        id: TEST_CP_CUSTODY_CONFIG_ID,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        provider: "local",
        config: "test-config",
        encryptionVersion: "sdp-custody-encryption-v1",
        defaultWalletId: null,
        status: "active",
        createdAt: seededAt,
        updatedAt: seededAt,
      },
      {
        id: TEST_CP_CUSTODY_WALLET_ID,
        custodyConfigId: TEST_CP_CUSTODY_CONFIG_ID,
        walletId: TEST_CP_WALLET_PUBLIC_KEY,
        publicKey: TEST_CP_WALLET_PUBLIC_KEY,
        label: "Counterparties test wallet",
        purpose: "transfer",
        status: "active",
        createdAt: seededAt,
      }
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

    it("returns 404 for another project's counterparty", async () => {
      const created = await createCounterparty({ externalId: "cross_project" });
      const counterparty = (await created.json()).data.counterparty;
      const res = await app.request(
        `/v1/counterparties/${counterparty.id}`,
        { headers: { Authorization: `Bearer ${TEST_PRODUCTION_API_KEY.raw}` } },
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
        `/v1/counterparties/${cp.id}/requirements?provider=moonpay&direction=onramp&assetRail=usdc.solana&fiatCurrency=USD`,
        { headers: { Authorization: authHeader } },
        env
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toContain(
        "destinationCustodyWalletId is required for onramp requirements"
      );
      expect(body.error.details.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["destinationCustodyWalletId"],
            message: "destinationCustodyWalletId is required for onramp requirements",
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
        `/v1/counterparties/${counterparty.id}/requirements?provider=lightspark&direction=offramp&assetRail=usdc.solana&fiatCurrency=USD`,
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
        `/v1/counterparties/${counterparty.id}/requirements?provider=lightspark&direction=offramp&assetRail=usdc.solana&fiatCurrency=USD&destinationCountry=US`,
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
        "/v1/counterparties/cp_invalid_country/requirements?provider=lightspark&direction=offramp&assetRail=usdc.solana&fiatCurrency=USD&destinationCountry=USA",
        { headers: { Authorization: authHeader } },
        env
      );

      expect(response.status).toBe(400);
    });

    it("rejects destinationCountry for non-Lightspark off-ramp requirements", async () => {
      const response = await app.request(
        "/v1/counterparties/cp_bvnk_country/requirements?provider=bvnk&direction=offramp&assetRail=usdc.solana&fiatCurrency=USD&destinationCountry=US",
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
            assetRail: "usdc.solana",
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
            assetRail: "usdc.solana",
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
            assetRail: "usdc.solana",
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

    it("returns the BVNK residence step for a fresh counterparty", async () => {
      const created = await createCounterparty({ externalId: "requirements_bvnk" });
      expect(created.status).toBe(201);
      const counterparty = (await created.json()).data.counterparty;

      const res = await app.request(
        `/v1/counterparties/${counterparty.id}/requirements?provider=bvnk&direction=onramp&assetRail=usdc.solana&fiatCurrency=USD&destinationCustodyWalletId=cwlt_counterparties_test`,
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
        status: "collect_counterparty_residence",
        fields: BVNK_RESIDENCE_FIELDS,
      });
    });

    it("rejects an onramp requirements destination wallet outside the API key's bindings", async () => {
      const created = await createCounterparty({ externalId: "requirements_wallet_scope" });
      expect(created.status).toBe(201);
      const counterparty = (await created.json()).data.counterparty;

      const kv = createKVStoreSet(env);
      await kv.apiKeys.put(
        `key:${apiKeyHash}`,
        JSON.stringify({
          ...TEST_CACHED_API_KEY,
          projectId: TEST_PROJECT_ID,
          walletScope: "selected",
          walletBindings: [
            {
              walletId: "wallet_counterparties_other",
              custodyWalletId: "cwlt_counterparties_other",
              permissions: ["*"],
            },
          ],
        })
      );

      const res = await app.request(
        `/v1/counterparties/${counterparty.id}/requirements?provider=bvnk&direction=onramp&assetRail=usdc.solana&fiatCurrency=USD&destinationCustodyWalletId=${TEST_CP_CUSTODY_WALLET_ID}`,
        {
          headers: { "Content-Type": "application/json", Authorization: authHeader },
        },
        env
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.message).toBe("API key is not authorized for the requested wallet");
    });

    it("mints a v1 agreement session for the residence country and persists the link before PII", async () => {
      const created = await createCounterparty({ externalId: "requirements_bvnk_residence" });
      expect(created.status).toBe(201);
      const counterparty = (await created.json()).data.counterparty;
      const requests: string[] = [];
      const sessionBodies: unknown[] = [];
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const path = new URL(String(input)).pathname;
        requests.push(path);
        if (init !== undefined && init.body !== undefined) {
          sessionBodies.push(JSON.parse(String(init.body)));
        }
        if (path === "/platform/v1/customers/agreement/sessions") {
          return new Response(
            JSON.stringify({
              reference: BVNK_SESSION_REFERENCE,
              accountReference: "07f1fe9b-c14e-4a1d-a3fa-0768bac98033",
              status: "PENDING",
              customerType: "INDIVIDUAL",
              useCase: "EMBEDDED_FIAT_ACCOUNTS",
              countryCode: "US",
              expiresOn: "2027-09-16T13:07:34.439862563Z",
              agreements: [BVNK_SESSION_AGREEMENT],
            }),
            { status: 201, headers: { "Content-Type": "application/json" } }
          );
        }
        throw new Error(`unexpected fetch: ${path}`);
      });
      env.BVNK_SANDBOX_WALLET_ID = "wallet";
      env.BVNK_SANDBOX_HAWK_AUTH_ID = "auth";
      env.BVNK_SANDBOX_HAWK_SECRET_KEY = "secret";
      try {
        await getDb(env)
          .prepare(
            `INSERT INTO counterparty_provider_accounts (
               id, organization_id, project_id, counterparty_id, provider,
               provider_customer_reference, kind, status, metadata
             ) VALUES (?, ?, ?, ?, 'bvnk', 'stale-working-set', 'customer_link', 'archived', ?)`
          )
          .bind(`cpa_archived_${counterparty.id}`, TEST_ORG.id, TEST_PROJECT_ID, counterparty.id, {
            residenceCountryCode: "US",
          })
          .run();
        const response = await app.request(
          `/v1/counterparties/${counterparty.id}/requirements`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authHeader },
            body: JSON.stringify({
              provider: "bvnk",
              direction: "onramp",
              assetRail: "usdc.solana",
              destinationCustodyWalletId: "cwlt_counterparties_test",
              fiatCurrency: "USD",
              collectedData: { "taxIdentification.taxResidenceCountryCode": "US" },
            }),
          },
          env
        );
        expect(response.status).toBe(200);
        expect((await response.json()).data).toEqual({
          provider: "bvnk",
          direction: "onramp",
          status: "customer_agreement_required",
          agreements: [BVNK_STORED_AGREEMENT],
        });
        expect(sessionBodies[0]).toEqual({
          customerType: "INDIVIDUAL",
          countryCode: "US",
          useCase: "EMBEDDED_FIAT_ACCOUNTS",
        });
        expect(requests).toEqual(["/platform/v1/customers/agreement/sessions"]);
        const row = await getDb(env)
          .prepare(
            `SELECT provider_customer_reference, metadata, status FROM counterparty_provider_accounts
             WHERE counterparty_id = ? AND provider = 'bvnk' AND kind = 'customer_link'`
          )
          .bind(counterparty.id)
          .first<{
            provider_customer_reference: string;
            metadata: Record<string, unknown>;
            status: string;
          }>();
        if (!row) {
          throw new Error("Expected BVNK customer-link row");
        }
        expect(row.status).toBe("active");
        expect(row.provider_customer_reference).toBe(
          buildBvnkCustomerExternalReference(counterparty.id)
        );
        expect(row.metadata).toEqual({
          residenceCountryCode: "US",
          session: {
            reference: BVNK_SESSION_REFERENCE,
            agreements: [BVNK_STORED_AGREEMENT],
          },
        });
      } finally {
        fetchSpy.mockRestore();
        env.BVNK_SANDBOX_WALLET_ID = undefined;
        env.BVNK_SANDBOX_HAWK_AUTH_ID = undefined;
        env.BVNK_SANDBOX_HAWK_SECRET_KEY = undefined;
      }
    });

    it("signs the stored agreement session on consent and forwards the consenting user's IP", async () => {
      const created = await createCounterparty({ externalId: "requirements_bvnk_consent" });
      expect(created.status).toBe(201);
      const counterparty = (await created.json()).data.counterparty;
      const repository = createPostgresCounterpartyProviderAccountsRepository(getDb(env));
      await repository.upsertProviderAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        provider: "bvnk",
        providerCustomerReference: buildBvnkCustomerExternalReference(counterparty.id),
        metadata: {
          residenceCountryCode: "US",
          session: {
            reference: BVNK_SESSION_REFERENCE,
            agreements: [BVNK_STORED_AGREEMENT],
          },
        },
      });
      const requests: string[] = [];
      const signBodies: unknown[] = [];
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const path = new URL(String(input)).pathname;
        requests.push(path);
        if (init !== undefined && init.body !== undefined) {
          signBodies.push(JSON.parse(String(init.body)));
        }
        if (path === `/platform/v1/customers/agreement/sessions/${BVNK_SESSION_REFERENCE}`) {
          return new Response(null, { status: 204 });
        }
        throw new Error(`unexpected fetch: ${path}`);
      });
      env.BVNK_SANDBOX_WALLET_ID = "wallet";
      env.BVNK_SANDBOX_HAWK_AUTH_ID = "auth";
      env.BVNK_SANDBOX_HAWK_SECRET_KEY = "secret";
      env.K_SERVICE = "test-service";
      try {
        const response = await app.request(
          `/v1/counterparties/${counterparty.id}/requirements`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: authHeader,
              "x-forwarded-for": "203.0.113.9, 10.0.0.1",
            },
            body: JSON.stringify({
              provider: "bvnk",
              direction: "onramp",
              assetRail: "usdc.solana",
              destinationCustodyWalletId: "cwlt_counterparties_test",
              fiatCurrency: "USD",
              agreementConsent: true,
            }),
          },
          env
        );
        expect(response.status).toBe(200);
        expect((await response.json()).data).toEqual({
          provider: "bvnk",
          direction: "onramp",
          status: "collect_counterparty",
          fields: bvnkOnrampFields("US"),
        });
        expect(requests).toEqual([
          `/platform/v1/customers/agreement/sessions/${BVNK_SESSION_REFERENCE}`,
        ]);
        expect(signBodies[0]).toEqual({ status: "SIGNED", ipAddress: "203.0.113.9" });
        const row = await getDb(env)
          .prepare(
            `SELECT metadata FROM counterparty_provider_accounts
             WHERE counterparty_id = ? AND provider = 'bvnk' AND kind = 'customer_link'`
          )
          .bind(counterparty.id)
          .first<{ metadata: Record<string, unknown> }>();
        expect(row?.metadata).toEqual({
          residenceCountryCode: "US",
          session: {
            reference: BVNK_SESSION_REFERENCE,
            agreements: [BVNK_STORED_AGREEMENT],
            signedAt: expect.any(String),
          },
        });
      } finally {
        fetchSpy.mockRestore();
        env.BVNK_SANDBOX_WALLET_ID = undefined;
        env.BVNK_SANDBOX_HAWK_AUTH_ID = undefined;
        env.BVNK_SANDBOX_HAWK_SECRET_KEY = undefined;
        env.K_SERVICE = undefined;
      }
    });

    it("signs the stored agreement from the TCP peer when proxy headers are untrusted", async () => {
      const created = await createCounterparty({ externalId: "requirements_bvnk_consent_peer_ip" });
      expect(created.status).toBe(201);
      const counterparty = (await created.json()).data.counterparty;
      const repository = createPostgresCounterpartyProviderAccountsRepository(getDb(env));
      await repository.upsertProviderAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        provider: "bvnk",
        providerCustomerReference: buildBvnkCustomerExternalReference(counterparty.id),
        metadata: {
          residenceCountryCode: "US",
          session: {
            reference: BVNK_SESSION_REFERENCE,
            agreements: [BVNK_STORED_AGREEMENT],
          },
        },
      });
      const signBodies: unknown[] = [];
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        if (init !== undefined && init.body !== undefined) {
          signBodies.push(JSON.parse(String(init.body)));
        }
        const path = new URL(String(input)).pathname;
        if (path === `/platform/v1/customers/agreement/sessions/${BVNK_SESSION_REFERENCE}`) {
          return new Response(null, { status: 204 });
        }
        throw new Error(`unexpected fetch: ${path}`);
      });
      env.BVNK_SANDBOX_WALLET_ID = "wallet";
      env.BVNK_SANDBOX_HAWK_AUTH_ID = "auth";
      env.BVNK_SANDBOX_HAWK_SECRET_KEY = "secret";
      env.K_SERVICE = undefined;
      env.TRUST_PROXY_HEADERS = undefined;
      try {
        const response = await app.request(
          `/v1/counterparties/${counterparty.id}/requirements`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: authHeader,
            },
            body: JSON.stringify({
              provider: "bvnk",
              direction: "onramp",
              assetRail: "usdc.solana",
              destinationCustodyWalletId: "cwlt_counterparties_test",
              fiatCurrency: "USD",
              agreementConsent: true,
            }),
          },
          env
        );
        expect(response.status).toBe(200);
        expect((await response.json()).data).toEqual({
          provider: "bvnk",
          direction: "onramp",
          status: "collect_counterparty",
          fields: bvnkOnrampFields("US"),
        });
        expect(signBodies[0]).toEqual({ status: "SIGNED", ipAddress: "0.0.0.0" });
        const row = await getDb(env)
          .prepare(
            `SELECT metadata FROM counterparty_provider_accounts
             WHERE counterparty_id = ? AND provider = 'bvnk' AND kind = 'customer_link'`
          )
          .bind(counterparty.id)
          .first<{ metadata: Record<string, unknown> }>();
        expect(row?.metadata).toEqual({
          residenceCountryCode: "US",
          session: {
            reference: BVNK_SESSION_REFERENCE,
            agreements: [BVNK_STORED_AGREEMENT],
            signedAt: expect.any(String),
          },
        });
      } finally {
        fetchSpy.mockRestore();
        env.BVNK_SANDBOX_WALLET_ID = undefined;
        env.BVNK_SANDBOX_HAWK_AUTH_ID = undefined;
        env.BVNK_SANDBOX_HAWK_SECRET_KEY = undefined;
        env.TRUST_PROXY_HEADERS = "true";
      }
    });

    it("creates the v1 customer from the full pack and flips the link reference", async () => {
      const created = await createCounterparty({ externalId: "requirements_bvnk_confirmed" });
      const counterparty = (await created.json()).data.counterparty;
      const collectedData = {
        firstName: "Ada",
        lastName: "Lovelace",
        dateOfBirth: "1815-12-10",
        email: "ada@example.com",
        "address.line1": "1 Main Street",
        "address.city": "Austin",
        "address.postalCode": "78701",
        "address.countryCode": "US",
        "address.subdivisionCode": "MO",
        "taxIdentification.number": "123-45-6789",
        birthCountryCode: "GB",
        nationality: "GB",
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
        providerCustomerReference: buildBvnkCustomerExternalReference(counterparty.id),
        metadata: {
          residenceCountryCode: "US",
          session: {
            reference: BVNK_SESSION_REFERENCE,
            signedAt: "2026-09-16T13:07:42.298Z",
            agreements: [BVNK_STORED_AGREEMENT],
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
      const createBodies: unknown[] = [];
      let createIdempotencyKey: string | null = null;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        requests.push(url.pathname);
        if (init?.body !== undefined) {
          createBodies.push(JSON.parse(String(init.body)));
          createIdempotencyKey = new Headers(init.headers).get("X-Idempotency-Key");
        }
        if (url.pathname === "/platform/v1/customers") {
          return new Response(
            JSON.stringify({
              reference: BVNK_CUSTOMER_REFERENCE,
              status: "PENDING",
            }),
            { status: 201, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.pathname === `/platform/v1/customers/${BVNK_CUSTOMER_REFERENCE}`) {
          return new Response(JSON.stringify(BVNK_CUSTOMER_DETAIL), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`unexpected fetch: ${url.pathname}`);
      });
      env.BVNK_SANDBOX_WALLET_ID = "wallet";
      env.BVNK_SANDBOX_HAWK_AUTH_ID = "auth";
      env.BVNK_SANDBOX_HAWK_SECRET_KEY = "secret";
      try {
        const requirements = await app.request(
          `/v1/counterparties/${counterparty.id}/requirements?provider=bvnk&direction=onramp&assetRail=usdc.solana&fiatCurrency=USD&destinationCustodyWalletId=cwlt_counterparties_test`,
          { headers: { "Content-Type": "application/json", Authorization: authHeader } },
          env
        );
        expect(requirements.status).toBe(200);
        const body = await requirements.json();
        expect(body.data.status).toBe("collect_counterparty");
        expect(body.data.fields).toEqual(bvnkOnrampFields("US"));
        expect(requests).toEqual([]);

        const partial = await app.request(
          `/v1/counterparties/${counterparty.id}/requirements`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authHeader },
            body: JSON.stringify({
              provider: "bvnk",
              direction: "onramp",
              assetRail: "usdc.solana",
              destinationCustodyWalletId: "cwlt_counterparties_test",
              fiatCurrency: "USD",
              collectedData: {
                firstName: "Ada",
                lastName: "Lovelace",
                email: "ada@example.com",
              },
            }),
          },
          env
        );
        expect(partial.status).toBe(200);
        const partialBody = await partial.json();
        expect(partialBody.data.status).toBe("collect_counterparty");
        const missingKeys = partialBody.data.fields.map((field: { key: string }) => field.key);
        expect(missingKeys).toContain("address.subdivisionCode");
        expect(missingKeys).toContain("cdd.employmentStatus");
        expect(missingKeys).toContain("dateOfBirth");
        expect(missingKeys).not.toContain("firstName");
        expect(missingKeys).not.toContain("lastName");
        expect(missingKeys).not.toContain("email");
        const stateCodeField = partialBody.data.fields.find(
          (field: { key: string }) => field.key === "address.subdivisionCode"
        );
        expect(stateCodeField?.kind).toBe("select");
        const optionValues = (stateCodeField?.kind === "select" ? stateCodeField.options : []).map(
          (option: { value: string }) => option.value
        );
        expect(optionValues).toEqual(Object.keys(BVNK_US_MTL_STATES));
        expect(optionValues).not.toContain("TX");
        expect(optionValues).not.toContain("NY");
        expect(requests).toEqual([]);

        const response = await app.request(
          `/v1/counterparties/${counterparty.id}/requirements`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authHeader },
            body: JSON.stringify({
              provider: "bvnk",
              direction: "onramp",
              assetRail: "usdc.solana",
              destinationCustodyWalletId: "cwlt_counterparties_test",
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
          status: "customer_verification_required",
          verificationUrl: BVNK_CUSTOMER_DETAIL.verification.url,
        });
        expect(requests).toEqual([
          "/platform/v1/customers",
          `/platform/v1/customers/${BVNK_CUSTOMER_REFERENCE}`,
        ]);
        expect(createBodies.length).toBe(1);
        expect(createBodies[0]).toEqual({
          type: "individual",
          externalReference: buildBvnkCustomerExternalReference(counterparty.id),
          signedAgreementSessionReference: BVNK_SESSION_REFERENCE,
          individual: buildBvnkCustomerRequest(collectedData, "US"),
        });
        expect(createIdempotencyKey).toBe(
          (await hashString(`bvnk-customer:${counterparty.id}`)).slice(0, 36)
        );
        const after = await repository.getProviderAccount({
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT_ID,
          counterpartyId: counterparty.id,
          provider: "bvnk",
        });
        expect(after?.id).toBe(before.id);
        expect(after?.provider_customer_reference).toBe(BVNK_CUSTOMER_REFERENCE);
        expect(after?.metadata).toEqual({
          status: "INFO_REQUIRED",
          verificationStatus: "init",
        });
      } finally {
        fetchSpy.mockRestore();
        env.BVNK_SANDBOX_WALLET_ID = undefined;
        env.BVNK_SANDBOX_HAWK_AUTH_ID = undefined;
        env.BVNK_SANDBOX_HAWK_SECRET_KEY = undefined;
      }
    });

    it("returns customer_verifying when the fresh customer is PENDING with no Sumsub link", async () => {
      const created = await createCounterparty({ externalId: "requirements_bvnk_pending" });
      const counterparty = (await created.json()).data.counterparty;
      const collectedData = {
        firstName: "Ada",
        lastName: "Lovelace",
        dateOfBirth: "1815-12-10",
        email: "ada@example.com",
        "address.line1": "1 Main Street",
        "address.city": "Austin",
        "address.postalCode": "78701",
        "address.countryCode": "US",
        "address.subdivisionCode": "MO",
        "taxIdentification.number": "123-45-6789",
        birthCountryCode: "GB",
        nationality: "GB",
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
        providerCustomerReference: buildBvnkCustomerExternalReference(counterparty.id),
        metadata: {
          residenceCountryCode: "US",
          session: {
            reference: BVNK_SESSION_REFERENCE,
            signedAt: "2026-09-16T13:07:42.298Z",
            agreements: [BVNK_STORED_AGREEMENT],
          },
        },
      });
      const requests: string[] = [];
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = new URL(String(input));
        requests.push(url.pathname);
        if (url.pathname === "/platform/v1/customers") {
          return new Response(
            JSON.stringify({
              reference: BVNK_CUSTOMER_REFERENCE,
              status: "PENDING",
            }),
            { status: 201, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.pathname === `/platform/v1/customers/${BVNK_CUSTOMER_REFERENCE}`) {
          return new Response(
            JSON.stringify({
              ...BVNK_CUSTOMER_DETAIL,
              status: "PENDING",
              verification: { status: "pending" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        throw new Error(`unexpected fetch: ${url.pathname}`);
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
              assetRail: "usdc.solana",
              destinationCustodyWalletId: "cwlt_counterparties_test",
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
          status: "customer_verifying",
        });
        expect(requests).toEqual([
          "/platform/v1/customers",
          `/platform/v1/customers/${BVNK_CUSTOMER_REFERENCE}`,
        ]);
        const after = await repository.getProviderAccount({
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT_ID,
          counterpartyId: counterparty.id,
          provider: "bvnk",
        });
        expect(after?.provider_customer_reference).toBe(BVNK_CUSTOMER_REFERENCE);
        expect(after?.metadata).toEqual({
          status: "PENDING",
          verificationStatus: "pending",
        });
      } finally {
        fetchSpy.mockRestore();
        env.BVNK_SANDBOX_WALLET_ID = undefined;
        env.BVNK_SANDBOX_HAWK_AUTH_ID = undefined;
        env.BVNK_SANDBOX_HAWK_SECRET_KEY = undefined;
      }
    });

    it("recovers an ACCOUNTS-2000 externalReference conflict via the v2 search", async () => {
      const created = await createCounterparty({ externalId: "requirements_bvnk_conflict" });
      const counterparty = (await created.json()).data.counterparty;
      const collectedData = {
        firstName: "Ada",
        lastName: "Lovelace",
        dateOfBirth: "1815-12-10",
        email: "ada@example.com",
        "address.line1": "1 Main Street",
        "address.city": "Austin",
        "address.postalCode": "78701",
        "address.countryCode": "US",
        "address.subdivisionCode": "MO",
        "taxIdentification.number": "123-45-6789",
        birthCountryCode: "GB",
        nationality: "GB",
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
        providerCustomerReference: buildBvnkCustomerExternalReference(counterparty.id),
        metadata: {
          residenceCountryCode: "US",
          session: {
            reference: BVNK_SESSION_REFERENCE,
            signedAt: "2026-09-16T13:07:42.298Z",
            agreements: [BVNK_STORED_AGREEMENT],
          },
        },
      });
      const requests: string[] = [];
      const searchQueries: string[] = [];
      let createCalls = 0;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = new URL(String(input));
        requests.push(url.pathname);
        if (url.pathname === "/platform/v1/customers") {
          createCalls += 1;
          return new Response(
            JSON.stringify({
              code: "ACCOUNTS-2000",
              traceId: "6aaa94d1184d65e454d08a790495961b",
              status: "Bad Request",
              message: "Invalid request",
              details: {
                errors: {
                  externalReference: [
                    "Customer with external reference: probe_v1_1789564047204 already exists",
                  ],
                  signedAgreementSessionReference: [
                    "Agreement session with reference: c1d91c8b-f4a6-469e-953d-7344fdb6858c is already assigned to the customer",
                  ],
                },
              },
            }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.pathname === "/platform/v2/customers") {
          searchQueries.push(url.searchParams.get("reference") ?? "");
          return new Response(
            JSON.stringify({
              totalElements: 1,
              totalPages: 1,
              content: [
                {
                  id: BVNK_CUSTOMER_REFERENCE,
                  reference: "probe_v1_1789564047204",
                  status: "ACTIONS_REQUIRED",
                  type: "INDIVIDUAL",
                  model: "EMBEDDED",
                  name: "Jane Doe",
                  createdAt: "2026-09-16T13:07:50.438748Z",
                },
              ],
              pageable: { pageNumber: 0, pageSize: 64 },
              hasNext: false,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.pathname === `/platform/v1/customers/${BVNK_CUSTOMER_REFERENCE}`) {
          return new Response(
            JSON.stringify({
              ...BVNK_CUSTOMER_DETAIL,
              status: "ACTIONS_REQUIRED",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        throw new Error(`unexpected fetch: ${url.pathname}`);
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
              assetRail: "usdc.solana",
              destinationCustodyWalletId: "cwlt_counterparties_test",
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
          status: "customer_verification_required",
          verificationUrl: BVNK_CUSTOMER_DETAIL.verification.url,
        });
        expect(createCalls).toBe(1);
        expect(requests).toEqual([
          "/platform/v1/customers",
          "/platform/v2/customers",
          `/platform/v1/customers/${BVNK_CUSTOMER_REFERENCE}`,
        ]);
        expect(searchQueries).toEqual([buildBvnkCustomerExternalReference(counterparty.id)]);
        const after = await repository.getProviderAccount({
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT_ID,
          counterpartyId: counterparty.id,
          provider: "bvnk",
        });
        expect(after?.provider_customer_reference).toBe(BVNK_CUSTOMER_REFERENCE);
        expect(after?.metadata).toEqual({
          status: "ACTIONS_REQUIRED",
          verificationStatus: "init",
        });
      } finally {
        fetchSpy.mockRestore();
        env.BVNK_SANDBOX_WALLET_ID = undefined;
        env.BVNK_SANDBOX_HAWK_AUTH_ID = undefined;
        env.BVNK_SANDBOX_HAWK_SECRET_KEY = undefined;
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
      const customerLink = await createPostgresCounterpartyProviderAccountsRepository(
        getDb(env)
      ).upsertProviderAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: owner.id,
        provider: "lightspark",
        providerCustomerReference: "Customer:owner",
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
            customerLink: {
              id: customerLink.id,
              providerCustomerReference: "Customer:owner",
              status: "active",
              providerStatus: null,
              createdAt: customerLink.created_at,
            },
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
            customerLink: {
              id: customerLink.id,
              providerCustomerReference: "Customer:owner",
              status: "active",
              providerStatus: null,
              createdAt: customerLink.created_at,
            },
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

    it("lists the customer link as a top-level row in creation order when its provider has no payout accounts", async () => {
      const created = await createCounterparty({ externalId: "provider_accounts_link_only" });
      const owner = (await created.json()).data.counterparty;
      const customerLink = await createPostgresCounterpartyProviderAccountsRepository(
        getDb(env)
      ).upsertProviderAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: owner.id,
        provider: "lightspark",
        providerCustomerReference: "Customer:link_only",
      });
      await seedProviderAccount({
        id: "provider_account_after_link",
        counterpartyId: owner.id,
        provider: "mural",
        providerCustomerReference: "mural_customer",
        externalAccountReference: "mural_external",
        fiatCurrency: "GBP",
        destinationCountry: "GB",
        paymentRail: "FPS",
        providerStatus: "ACTIVE",
        status: "active",
        createdAt: "2099-01-01T00:00:00.000Z",
      });

      const response = await app.request(
        `/v1/counterparties/${owner.id}/provider-accounts`,
        { headers: { Authorization: authHeader } },
        env
      );

      expect(response.status).toBe(200);
      expect((await response.json()).data).toEqual({
        accounts: [
          {
            id: customerLink.id,
            provider: "lightspark",
            kind: "customer_link",
            fiatCurrency: null,
            destinationCountry: null,
            paymentRail: null,
            status: "active",
            providerStatus: null,
            createdAt: customerLink.created_at,
            customerLink: {
              id: customerLink.id,
              providerCustomerReference: "Customer:link_only",
              status: "active",
              providerStatus: null,
              createdAt: customerLink.created_at,
            },
          },
          {
            id: "provider_account_after_link",
            provider: "mural",
            kind: "payout_account",
            fiatCurrency: "GBP",
            destinationCountry: "GB",
            paymentRail: "FPS",
            status: "active",
            providerStatus: "ACTIVE",
            createdAt: "2099-01-01T00:00:00.000Z",
          },
        ],
      });
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
