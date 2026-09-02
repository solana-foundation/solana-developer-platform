import { afterAll, assert, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { createPostgresCounterpartiesRepository } from "./counterparty.repository.postgres";
import type { CounterpartyProviderAccountsRepository } from "./counterparty-provider-account.repository";
import { createPostgresCounterpartyProviderAccountsRepository } from "./counterparty-provider-account.repository.postgres";

const TEST_PROJECT_ID = "prj_cpacc_repo_test";

describe("CounterpartyProviderAccountsRepository (postgres)", () => {
  let repository: CounterpartyProviderAccountsRepository;

  beforeAll(async () => {
    await seedTestDatabase(env);
  });

  afterAll(async () => {
    await seedTestDatabase(env);
  });

  beforeEach(async () => {
    const db = getDb(env);
    await db.prepare("DELETE FROM counterparty_provider_accounts").run();
    await db.prepare("DELETE FROM counterparties").run();
    await db.prepare("DELETE FROM projects").run();
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
         VALUES (?, ?, 'Provider Accounts', 'provider-accounts', 'sandbox', 'active', ?)`
      )
      .bind(TEST_PROJECT_ID, TEST_ORG.id, TEST_USER.id)
      .run();
    repository = createPostgresCounterpartyProviderAccountsRepository(db);
  });

  /**
   * Seeds one counterparty under the repository test scope.
   *
   * @param externalId - Stable fixture external id.
   * @returns The created counterparty row.
   */
  async function seedCounterparty(externalId: string) {
    const counterparty = await createPostgresCounterpartiesRepository(
      getDb(env)
    ).createCounterparty({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      externalId,
      entityType: "individual",
      displayName: "Ada Lovelace",
      providerData: {},
      createdBy: TEST_USER.id,
    });
    assert(counterparty);
    return counterparty;
  }

  it("keeps the customer row distinct from corridor rows", async () => {
    const counterparty = await seedCounterparty("cpacc_distinct_rows");
    const customer = await repository.upsertProviderAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "lightspark",
      providerCustomerReference: "Customer:cus_123",
    });
    const external = await repository.insertPendingExternalAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "lightspark",
      providerCustomerReference: customer.provider_customer_reference,
      fiatCurrency: "USD",
      destinationCountry: "US",
      paymentRail: "ACH",
    });

    expect(customer.id).toMatch(/^counterparty_provider_account_/);
    expect(customer.fiat_currency).toBeNull();
    expect(customer.destination_country).toBeNull();
    expect(customer.payment_rail).toBeNull();
    expect(external.id).toMatch(/^counterparty_provider_account_/);
    expect(external.id).not.toBe(customer.id);
    expect(external).toMatchObject({
      provider_customer_reference: customer.provider_customer_reference,
      external_account_reference: null,
      fiat_currency: "USD",
      destination_country: "US",
      payment_rail: "ACH",
      provider_status: null,
      status: "active",
    });
    expect(
      await repository.getProviderAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        provider: "lightspark",
      })
    ).toMatchObject({ id: customer.id });
  });

  it("allows multiple active accounts for the same corridor and rail", async () => {
    const counterparty = await seedCounterparty("cpacc_multiple_active_accounts");
    const customer = await repository.upsertProviderAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "lightspark",
      providerCustomerReference: "Customer:cus_123",
    });
    const input = {
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "lightspark",
      providerCustomerReference: customer.provider_customer_reference,
      fiatCurrency: "USD",
      destinationCountry: "US",
      paymentRail: "ACH",
    } as const;

    const first = await repository.insertPendingExternalAccount(input);
    const second = await repository.insertPendingExternalAccount(input);

    expect(second.id).not.toBe(first.id);
    expect(
      await repository.listActiveExternalAccounts({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        provider: "lightspark",
        fiatCurrency: "USD",
        destinationCountry: "US",
      })
    ).toHaveLength(2);
  });

  it("scopes external account lookup to the parent counterparty", async () => {
    const counterparty = await seedCounterparty("cpacc_lookup_owner");
    const otherCounterparty = await seedCounterparty("cpacc_lookup_other");
    const customer = await repository.upsertProviderAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "lightspark",
      providerCustomerReference: "Customer:cus_lookup",
    });
    const external = await repository.insertPendingExternalAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "lightspark",
      providerCustomerReference: customer.provider_customer_reference,
      fiatCurrency: "USD",
      destinationCountry: "US",
      paymentRail: "ACH",
    });

    expect(
      await repository.getExternalAccountById({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: otherCounterparty.id,
        provider: "lightspark",
        id: external.id,
      })
    ).toBeNull();
    expect(
      await repository.getExternalAccountById({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        provider: "lightspark",
        id: external.id,
      })
    ).toMatchObject({ id: external.id });
  });

  it("scopes completion, status updates, and archival to all parent ids", async () => {
    const counterparty = await seedCounterparty("cpacc_scoped_mutations");
    const customer = await repository.upsertProviderAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "lightspark",
      providerCustomerReference: "Customer:cus_123",
    });
    const pending = await repository.insertPendingExternalAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "lightspark",
      providerCustomerReference: customer.provider_customer_reference,
      fiatCurrency: "USD",
      destinationCountry: "US",
      paymentRail: "ACH",
    });
    const wrongScope = {
      organizationId: TEST_ORG.id,
      projectId: "prj_other",
      counterpartyId: counterparty.id,
      provider: "lightspark",
      id: pending.id,
    } as const;

    expect(
      await repository.completeExternalAccount({
        ...wrongScope,
        externalAccountReference: "ExternalAccount:acc_123",
        providerStatus: "PENDING",
      })
    ).toBeNull();
    const completed = await repository.completeExternalAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "lightspark",
      id: pending.id,
      externalAccountReference: "ExternalAccount:acc_123",
      providerStatus: "PENDING",
    });
    expect(completed).toMatchObject({
      external_account_reference: "ExternalAccount:acc_123",
      provider_status: "PENDING",
    });
    expect(
      await repository.updateExternalAccountStatus({ ...wrongScope, providerStatus: "ACTIVE" })
    ).toBeNull();
    const active = await repository.updateExternalAccountStatus({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "lightspark",
      id: pending.id,
      providerStatus: "ACTIVE",
    });
    assert(active);
    expect(active.provider_status).toBe("ACTIVE");
    expect(await repository.archiveExternalAccount(wrongScope)).toBeNull();
    const archived = await repository.archiveExternalAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "lightspark",
      id: pending.id,
    });
    assert(archived);
    expect(archived.status).toBe("archived");
    expect(
      await repository.listActiveExternalAccounts({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        provider: "lightspark",
        fiatCurrency: "USD",
        destinationCountry: "US",
      })
    ).toEqual([]);
  });

  it("allows a replacement corridor row after archival", async () => {
    const counterparty = await seedCounterparty("cpacc_replacement");
    const customer = await repository.upsertProviderAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "lightspark",
      providerCustomerReference: "Customer:cus_123",
    });
    const first = await repository.insertPendingExternalAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "lightspark",
      providerCustomerReference: customer.provider_customer_reference,
      fiatCurrency: "USD",
      destinationCountry: "US",
      paymentRail: "ACH",
    });
    await repository.archiveExternalAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "lightspark",
      id: first.id,
    });
    const replacement = await repository.insertPendingExternalAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "lightspark",
      providerCustomerReference: customer.provider_customer_reference,
      fiatCurrency: "USD",
      destinationCountry: "US",
      paymentRail: "ACH",
    });

    expect(replacement.id).not.toBe(first.id);
  });
});
