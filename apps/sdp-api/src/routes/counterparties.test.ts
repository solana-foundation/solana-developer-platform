import { hashString } from "@sdp/payments/hash";
import { type OrganizationProviderOverrides, SDP_RAMP_PROVIDER_STAGES } from "@sdp/types";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "@/app";
import { getDb } from "@/db";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories";
import app from "@/index";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { noopObservability } from "@/runtime/observability";
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
import { installStripeTestEnv } from "@/test/helpers/stripe-env";
import { seedTestDatabase } from "@/test/mocks/db";

const TEST_PROJECT_ID = "prj_counterparties_test";
const TEST_CP_CUSTODY_WALLET_ID = "cwlt_counterparties_test";
const TEST_CP_CUSTODY_CONFIG_ID = "ccfg_counterparties_test";
const TEST_CP_WALLET_PUBLIC_KEY = "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ";
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
  const createCounterparty = (body: Record<string, unknown>) =>
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

  async function seedProviderAccount(input: {
    id: string;
    counterpartyId: string;
    provider: "lightspark" | "moonpay" | "stripe";
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

  async function setRampProviderOverrides(
    ramps: NonNullable<OrganizationProviderOverrides["ramps"]>
  ): Promise<void> {
    await getDb(env).execute(
      `UPDATE organizations
       SET settings = (COALESCE(NULLIF(settings, ''), '{}')::jsonb
                       || jsonb_build_object('providerOverrides', ?::jsonb))::text
       WHERE id = ?`,
      [JSON.stringify({ ramps }), TEST_ORG.id]
    );
  }

  afterEach(async () => {
    await getDb(env).execute(
      `UPDATE organizations
       SET settings = (COALESCE(NULLIF(settings, ''), '{}')::jsonb - 'providerOverrides')::text
       WHERE id = ?`,
      [TEST_ORG.id]
    );
  });

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
    afterEach(() => {
      vi.restoreAllMocks();
    });
    it("surfaces the missing destination wallet for onramp requirements", async () => {
      const created = await createCounterparty({});
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

    it("refuses a provider the organization isn't entitled to before any provider call", async () => {
      await setRampProviderOverrides({ moonpay: false });
      const created = await createCounterparty({ externalId: "requirements_unentitled" });
      const cp = (await created.json()).data.counterparty;
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const res = await app.request(
        `/v1/counterparties/${cp.id}/requirements?provider=moonpay&direction=onramp&assetRail=usdc.solana&fiatCurrency=USD&destinationCustodyWalletId=${TEST_CP_CUSTODY_WALLET_ID}`,
        { headers: { Authorization: authHeader } },
        env
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.details.reason).toBe("provider_not_entitled");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    describe("Stripe off-ramp", () => {
      installStripeTestEnv();

      it("reports unsupported on requirements submit", async () => {
        const created = await createCounterparty({ externalId: "stripe_offramp_requirements" });
        const cp = (await created.json()).data.counterparty;

        const res = await app.request(
          `/v1/counterparties/${cp.id}/requirements`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authHeader },
            body: JSON.stringify({ provider: "stripe", direction: "offramp" }),
          },
          env
        );

        expect(res.status).toBe(200);
        expect((await res.json()).data).toMatchObject({
          provider: "stripe",
          direction: "offramp",
          status: "unsupported",
          reason: "Stripe supports on-ramp only.",
        });
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
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("neither lists nor enriches accounts at a provider outside the release channel", async () => {
      const created = await createCounterparty({ externalId: "provider_accounts_channel" });
      const owner = (await created.json()).data.counterparty;
      await seedProviderAccount({
        id: "provider_account_excluded_stripe",
        counterpartyId: owner.id,
        provider: "stripe",
        providerCustomerReference: "Customer:owner",
        externalAccountReference: "ExternalAccount:excluded",
        fiatCurrency: "USD",
        destinationCountry: "US",
        paymentRail: "ACH",
        providerStatus: "ACTIVE",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      await seedProviderAccount({
        id: "provider_account_included_moonpay",
        counterpartyId: owner.id,
        provider: "moonpay",
        providerCustomerReference: "moonpay_customer",
        externalAccountReference: "moonpay_external",
        fiatCurrency: "GBP",
        destinationCountry: "GB",
        paymentRail: "FPS",
        providerStatus: "ACTIVE",
        status: "archived",
        createdAt: "2026-01-02T00:00:00.000Z",
      });
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      // Today every provider is `experimental`; these stages put only MoonPay in `beta`.
      const betaApp = createApp({
        observability: noopObservability,
        rampProviderStages: { ...SDP_RAMP_PROVIDER_STAGES, moonpay: "beta" },
      });

      const response = await betaApp.request(
        `/v1/counterparties/${owner.id}/provider-accounts`,
        { headers: { Authorization: authHeader } },
        { ...env, SDP_RELEASE_CHANNEL: "beta" }
      );

      expect(response.status).toBe(200);
      const { accounts } = (await response.json()).data as { accounts: { id: string }[] };
      expect(accounts.map((account) => account.id)).toEqual(["provider_account_included_moonpay"]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("neither lists nor enriches accounts at a provider the organization isn't entitled to", async () => {
      const created = await createCounterparty({ externalId: "provider_accounts_unentitled" });
      const owner = (await created.json()).data.counterparty;
      await seedProviderAccount({
        id: "provider_account_unentitled_stripe",
        counterpartyId: owner.id,
        provider: "stripe",
        providerCustomerReference: "Customer:unentitled",
        externalAccountReference: "ExternalAccount:unentitled",
        fiatCurrency: "USD",
        destinationCountry: "US",
        paymentRail: "ACH",
        providerStatus: "ACTIVE",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      await seedProviderAccount({
        id: "provider_account_entitled_moonpay",
        counterpartyId: owner.id,
        provider: "moonpay",
        providerCustomerReference: "moonpay_customer_entitled",
        externalAccountReference: null,
        fiatCurrency: "GBP",
        destinationCountry: "GB",
        paymentRail: "FPS",
        providerStatus: "ACTIVE",
        status: "archived",
        createdAt: "2026-01-02T00:00:00.000Z",
      });
      await setRampProviderOverrides({ stripe: false });
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const filtered = await app.request(
        `/v1/counterparties/${owner.id}/provider-accounts?provider=stripe`,
        { headers: { Authorization: authHeader } },
        env
      );
      expect(filtered.status).toBe(403);
      expect((await filtered.json()).error.details.reason).toBe("provider_not_entitled");

      const listed = await app.request(
        `/v1/counterparties/${owner.id}/provider-accounts`,
        { headers: { Authorization: authHeader } },
        env
      );
      expect(listed.status).toBe(200);
      const { accounts } = (await listed.json()).data as { accounts: { id: string }[] };
      expect(accounts.map((account) => account.id)).toEqual(["provider_account_entitled_moonpay"]);
      expect(fetchSpy).not.toHaveBeenCalled();
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
        provider: "stripe",
        providerCustomerReference: "Customer:link_only",
      });
      await seedProviderAccount({
        id: "provider_account_after_link",
        counterpartyId: owner.id,
        provider: "moonpay",
        providerCustomerReference: "moonpay_customer",
        externalAccountReference: "moonpay_external",
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
            provider: "stripe",
            kind: "customer_link",
            fiatCurrency: null,
            destinationCountry: null,
            paymentRail: null,
            status: "active",
            providerStatus: null,
            createdAt: customerLink.created_at,
            customerLink: {
              provider: "stripe",
              id: customerLink.id,
              providerCustomerReference: "Customer:link_only",
              status: "active",
              providerStatus: null,
              createdAt: customerLink.created_at,
            },
          },
          {
            id: "provider_account_after_link",
            provider: "moonpay",
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
