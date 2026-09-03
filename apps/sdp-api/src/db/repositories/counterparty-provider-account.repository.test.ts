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
    expect(customer.kind).toBe("customer_link");
    expect(external.id).toMatch(/^counterparty_provider_account_/);
    expect(external.id).not.toBe(customer.id);
    expect(external).toMatchObject({
      provider_customer_reference: customer.provider_customer_reference,
      external_account_reference: null,
      fiat_currency: "USD",
      destination_country: "US",
      payment_rail: "ACH",
      provider_status: null,
      kind: "payout_account",
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

  it("allows at most one live reservation per corridor and rail", async () => {
    const counterparty = await seedCounterparty("cpacc_reservation_unique");
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
    await expect(repository.insertPendingExternalAccount(input)).rejects.toMatchObject({
      code: "23505",
    });

    // Archiving the live reservation frees the corridor for a fresh one, and a
    // COMPLETED account does not block new reservations — only an in-flight one.
    const archived = await repository.archiveExternalAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "lightspark",
      id: first.id,
    });
    expect(archived?.status).toBe("archived");
    const replacementReservation = await repository.insertPendingExternalAccount(input);
    const completedReplacement = await repository.completeExternalAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "lightspark",
      id: replacementReservation.id,
      externalAccountReference: "ExternalAccount:reservation_unique",
      providerStatus: "ACTIVE",
    });
    expect(completedReplacement?.external_account_reference).toBe(
      "ExternalAccount:reservation_unique"
    );
    const afterCompletion = await repository.insertPendingExternalAccount(input);
    expect(afterCompletion.id).not.toBe(replacementReservation.id);
  });

  it("reads and updates provider resource accounts by kind", async () => {
    const counterparty = await seedCounterparty("cpacc_resource_accounts");
    const fundingWallet = await repository.insertProviderResourceAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "bvnk",
      providerCustomerReference: "bvnk_customer_resource",
      kind: "funding_wallet",
      fiatCurrency: "USD",
      externalAccountReference: "wallet_resource_1",
      metadata: {
        onrampKey: "USD:USDC_SOLANA:dest",
        request: {
          currency: "USDC",
          network: "SOLANA",
          destinationWalletAddress: "dest",
          fiatCurrency: "USD",
        },
      },
    });
    const merchantWallet = await repository.insertProviderResourceAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "bvnk",
      providerCustomerReference: "bvnk_customer_resource",
      kind: "merchant_wallet",
      fiatCurrency: "USD",
      externalAccountReference: "wallet_resource_2",
      metadata: {},
    });

    expect(
      await repository.getAccountByKindAndCurrency({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        provider: "bvnk",
        kind: "merchant_wallet",
        fiatCurrency: "USD",
      })
    ).toMatchObject({ id: merchantWallet.id, kind: "merchant_wallet" });
    expect(
      await repository.getFundingWalletByOnrampKey({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        provider: "bvnk",
        onrampKey: "USD:USDC_SOLANA:dest",
      })
    ).toMatchObject({ id: fundingWallet.id, kind: "funding_wallet" });

    const updated = await repository.patchAccountMetadata({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "bvnk",
      id: fundingWallet.id,
      set: { ruleStatus: "ACTIVE" },
      unset: [],
    });
    expect(updated?.metadata).toEqual({
      onrampKey: "USD:USDC_SOLANA:dest",
      ruleStatus: "ACTIVE",
      request: {
        fiatCurrency: "USD",
        currency: "USDC",
        network: "SOLANA",
        destinationWalletAddress: "dest",
      },
    });

    await expect(
      repository.patchAccountMetadata({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        provider: "bvnk",
        id: fundingWallet.id,
        set: {},
        unset: ["onrampKey"],
      })
    ).rejects.toThrow();
    expect(
      await repository.getFundingWalletByOnrampKey({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        provider: "bvnk",
        onrampKey: "USD:USDC_SOLANA:dest",
      })
    ).toMatchObject({
      id: fundingWallet.id,
      metadata: { onrampKey: "USD:USDC_SOLANA:dest", ruleStatus: "ACTIVE" },
    });
  });

  it("keeps customer links out of payout queries", async () => {
    const counterparty = await seedCounterparty("cpacc_kind_filters");
    await repository.upsertProviderAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "bvnk",
      providerCustomerReference: "bvnk_customer_kind_filter",
    });

    expect(
      await repository.listProviderAccounts({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
      })
    ).toEqual([]);
    expect(
      await repository.getAccountByKindAndCurrency({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        provider: "bvnk",
        kind: "payout_account",
        fiatCurrency: "USD",
      })
    ).toBeNull();

    const counterparties = createPostgresCounterpartiesRepository(getDb(env));
    expect(
      await counterparties.findActiveCounterpartyByProviderCustomerReference({
        provider: "bvnk",
        providerCustomerReference: "bvnk_customer_kind_filter",
      })
    ).toMatchObject({ id: counterparty.id });

    const duplicateCounterparty = await seedCounterparty("cpacc_kind_filter_duplicate");
    await repository.upsertProviderAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: duplicateCounterparty.id,
      provider: "bvnk",
      providerCustomerReference: "bvnk_customer_kind_filter",
    });
    expect(
      await counterparties.findActiveCounterpartyByProviderCustomerReference({
        provider: "bvnk",
        providerCustomerReference: "bvnk_customer_kind_filter",
      })
    ).toBeNull();
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

  it("lists active and archived external rows with parent and tenant filters", async () => {
    const counterparty = await seedCounterparty("cpacc_list_provider_accounts");
    const otherCounterparty = await seedCounterparty("cpacc_list_provider_accounts_other");
    const customer = await repository.upsertProviderAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "lightspark",
      providerCustomerReference: "Customer:list_provider_accounts",
    });
    const usd = await repository.insertPendingExternalAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "lightspark",
      providerCustomerReference: customer.provider_customer_reference,
      fiatCurrency: "USD",
      destinationCountry: "US",
      paymentRail: "ACH",
    });
    const gbp = await repository.insertPendingExternalAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "lightspark",
      providerCustomerReference: customer.provider_customer_reference,
      fiatCurrency: "GBP",
      destinationCountry: "GB",
      paymentRail: "FPS",
    });
    await repository.archiveExternalAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "lightspark",
      id: gbp.id,
    });

    expect(
      await repository.listProviderAccounts({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
      })
    ).toEqual([usd, expect.objectContaining({ id: gbp.id, status: "archived" })]);
    expect(
      await repository.listProviderAccounts({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        fiatCurrency: "USD",
        destinationCountry: "US",
      })
    ).toEqual([usd]);
    expect(
      await repository.listProviderAccounts({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: otherCounterparty.id,
      })
    ).toEqual([]);
    expect(
      await repository.listProviderAccounts({
        organizationId: "org_not_owned",
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
      })
    ).toEqual([]);
  });
});
