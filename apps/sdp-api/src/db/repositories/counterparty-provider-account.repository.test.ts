import { afterAll, assert, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { bvnkCustomerLinkSeed, bvnkOnrampRequest } from "@/test/helpers/bvnk";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { createPostgresCounterpartiesRepository } from "./counterparty.repository.postgres";
import {
  type CounterpartyProviderAccountsRepository,
  counterpartyProviderAccountUuid,
  generateCounterpartyProviderAccountId,
} from "./counterparty-provider-account.repository";
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
    await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [],
      ids: { sandbox: TEST_PROJECT_ID, production: `${TEST_PROJECT_ID}_production` },
    });
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
      metadata: { onrampKey: "USD:USDC_SOLANA:dest", request: bvnkOnrampRequest() },
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

  it("lists customer links but keeps them out of corridor reads", async () => {
    const counterparty = await seedCounterparty("cpacc_kind_filters");
    await repository.upsertProviderAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      ...bvnkCustomerLinkSeed("bvnk_customer_kind_filter"),
    });

    expect(
      await repository.listProviderAccounts({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
      })
    ).toEqual([expect.objectContaining({ kind: "customer_link", provider: "bvnk" })]);
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

    // A second counterparty claiming the same reference is refused at write
    // time by the 0080 unique index — the ambiguity the lookup used to fail
    // closed on can no longer be created, and the original owner keeps
    // resolving.
    const duplicateCounterparty = await seedCounterparty("cpacc_kind_filter_duplicate");
    await expect(
      repository.upsertProviderAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: duplicateCounterparty.id,
        ...bvnkCustomerLinkSeed("bvnk_customer_kind_filter"),
      })
    ).rejects.toMatchObject({ code: "23505" });
    expect(
      await counterparties.findActiveCounterpartyByProviderCustomerReference({
        provider: "bvnk",
        providerCustomerReference: "bvnk_customer_kind_filter",
      })
    ).toMatchObject({ id: counterparty.id });
  });

  it("assigns the v1 customer reference and metadata via the CAS alias", async () => {
    const counterparty = await seedCounterparty("cpacc_assign_hit");
    const alias = "cp_cpacc_assign_hit";
    const seeded = await repository.upsertProviderAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "bvnk",
      providerCustomerReference: alias,
      metadata: {
        residenceCountryCode: "US",
        session: {
          reference: "bvnk_session_assign_hit",
          agreements: [],
        },
      },
    });

    const assigned = await repository.assignCustomerLinkReference({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "bvnk",
      id: seeded.id,
      fromProviderCustomerReference: alias,
      providerCustomerReference: "2a9c8a29-5030-456d-87c2-7f6cc2ee6bf3",
      metadata: { status: "PENDING" },
    });

    expect(assigned).toMatchObject({
      id: seeded.id,
      provider_customer_reference: "2a9c8a29-5030-456d-87c2-7f6cc2ee6bf3",
      metadata: { status: "PENDING" },
    });
  });

  it("returns null on a CAS miss and leaves the row untouched", async () => {
    const counterparty = await seedCounterparty("cpacc_assign_miss");
    const alias = "cp_cpacc_assign_miss";
    const seeded = await repository.upsertProviderAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "bvnk",
      providerCustomerReference: alias,
      metadata: {
        residenceCountryCode: "US",
        session: {
          reference: "bvnk_session_assign_miss",
          agreements: [],
        },
      },
    });

    const assigned = await repository.assignCustomerLinkReference({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "bvnk",
      id: seeded.id,
      fromProviderCustomerReference: "cp_someone_else",
      providerCustomerReference: "2a9c8a29-5030-456d-87c2-7f6cc2ee6bf3",
      metadata: { status: "PENDING" },
    });

    expect(assigned).toBeNull();
    expect(
      await repository.getProviderAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        provider: "bvnk",
      })
    ).toMatchObject({
      id: seeded.id,
      provider_customer_reference: alias,
      status: "active",
      metadata: {
        residenceCountryCode: "US",
        session: {
          reference: "bvnk_session_assign_miss",
          agreements: [],
        },
      },
    });
  });

  it("scopes customer-link reference assignment to the parent tenant", async () => {
    const counterparty = await seedCounterparty("cpacc_assign_scope");
    const alias = "cp_cpacc_assign_scope";
    const seeded = await repository.upsertProviderAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "bvnk",
      providerCustomerReference: alias,
      metadata: {
        residenceCountryCode: "US",
        session: {
          reference: "bvnk_session_assign_scope",
          agreements: [],
        },
      },
    });

    expect(
      await repository.assignCustomerLinkReference({
        organizationId: TEST_ORG.id,
        projectId: `${TEST_PROJECT_ID}_production`,
        counterpartyId: counterparty.id,
        provider: "bvnk",
        id: seeded.id,
        fromProviderCustomerReference: alias,
        providerCustomerReference: "2a9c8a29-5030-456d-87c2-7f6cc2ee6bf3",
        metadata: { status: "PENDING" },
      })
    ).toBeNull();
    expect(
      await repository.getProviderAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        provider: "bvnk",
      })
    ).toMatchObject({
      id: seeded.id,
      provider_customer_reference: alias,
      status: "active",
      metadata: {
        residenceCountryCode: "US",
        session: {
          reference: "bvnk_session_assign_scope",
          agreements: [],
        },
      },
    });
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

  it("keeps the first claimed residence country on a repeat claim", async () => {
    const counterparty = await seedCounterparty("cpacc_residence_claim");
    const first = await repository.upsertProviderAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "bvnk",
      providerCustomerReference: "cp_cpacc_residence_claim",
      metadata: { residenceCountryCode: "US" },
    });

    const repeat = await repository.upsertProviderAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "bvnk",
      providerCustomerReference: "cp_cpacc_residence_claim",
      metadata: { residenceCountryCode: "GB" },
    });

    expect(repeat.id).toBe(first.id);
    expect(repeat.metadata).toEqual({ residenceCountryCode: "US" });
  });

  it("CAS-writes the minted session onto a claimed row", async () => {
    const counterparty = await seedCounterparty("cpacc_session_hit");
    const seeded = await repository.upsertProviderAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "bvnk",
      providerCustomerReference: "cp_cpacc_session_hit",
      metadata: { residenceCountryCode: "US" },
    });

    const written = await repository.setCustomerLinkSession({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "bvnk",
      id: seeded.id,
      session: {
        reference: "bvnk_session_hit",
        agreements: [],
      },
    });

    expect(written).toMatchObject({
      id: seeded.id,
      metadata: {
        residenceCountryCode: "US",
        session: { reference: "bvnk_session_hit", agreements: [] },
      },
    });
    expect(
      await repository.getProviderAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        provider: "bvnk",
      })
    ).toMatchObject({
      metadata: {
        residenceCountryCode: "US",
        session: { reference: "bvnk_session_hit", agreements: [] },
      },
    });
  });

  it("returns null on a session CAS miss and leaves the row untouched", async () => {
    const counterparty = await seedCounterparty("cpacc_session_miss");
    const seeded = await repository.upsertProviderAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "bvnk",
      providerCustomerReference: "cp_cpacc_session_miss",
      metadata: {
        residenceCountryCode: "US",
        session: { reference: "bvnk_session_first", agreements: [] },
      },
    });

    const written = await repository.setCustomerLinkSession({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "bvnk",
      id: seeded.id,
      session: { reference: "bvnk_session_second", agreements: [] },
    });

    expect(written).toBeNull();
    expect(
      await repository.getProviderAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        provider: "bvnk",
      })
    ).toMatchObject({
      id: seeded.id,
      metadata: {
        residenceCountryCode: "US",
        session: { reference: "bvnk_session_first", agreements: [] },
      },
    });
  });

  it("scopes the session CAS write to the parent tenant", async () => {
    const counterparty = await seedCounterparty("cpacc_session_scope");
    const seeded = await repository.upsertProviderAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "bvnk",
      providerCustomerReference: "cp_cpacc_session_scope",
      metadata: { residenceCountryCode: "US" },
    });

    expect(
      await repository.setCustomerLinkSession({
        organizationId: TEST_ORG.id,
        projectId: `${TEST_PROJECT_ID}_production`,
        counterpartyId: counterparty.id,
        provider: "bvnk",
        id: seeded.id,
        session: { reference: "bvnk_session_scope", agreements: [] },
      })
    ).toBeNull();
    expect(
      await repository.getProviderAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        provider: "bvnk",
      })
    ).toMatchObject({
      id: seeded.id,
      metadata: { residenceCountryCode: "US" },
    });
  });

  it("finds an active customer link by agreement-session reference", async () => {
    const counterparty = await seedCounterparty("cpacc_session_reference");
    const seeded = await repository.upsertProviderAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "bvnk",
      providerCustomerReference: "cp_cpacc_session_reference",
      metadata: {
        residenceCountryCode: "US",
        session: { reference: "bvnk_session_reference", agreements: [] },
      },
    });

    expect(
      await repository.findCustomerLinkBySessionReference({
        provider: "bvnk",
        sessionReference: "bvnk_session_reference",
      })
    ).toMatchObject({ id: seeded.id });
    expect(
      await repository.findCustomerLinkBySessionReference({
        provider: "bvnk",
        sessionReference: "missing_session_reference",
      })
    ).toBeNull();
  });

  it("CAS-marks an agreement session signed within its counterparty scope", async () => {
    const counterparty = await seedCounterparty("cpacc_session_signed");
    const otherCounterparty = await seedCounterparty("cpacc_session_signed_other");
    const seeded = await repository.upsertProviderAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "bvnk",
      providerCustomerReference: "cp_cpacc_session_signed",
      metadata: {
        residenceCountryCode: "US",
        session: { reference: "bvnk_session_signed", agreements: [] },
      },
    });
    const input: {
      organizationId: string;
      projectId: string;
      counterpartyId: string;
      provider: "bvnk";
      id: string;
      sessionReference: string;
      field: "signedAt";
      timestamp: string;
    } = {
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "bvnk",
      id: seeded.id,
      sessionReference: "bvnk_session_signed",
      field: "signedAt",
      timestamp: "2026-09-16T17:19:03.631Z",
    };

    expect(
      await repository.markCustomerLinkSessionTimestamp({
        ...input,
        counterpartyId: otherCounterparty.id,
      })
    ).toBeNull();
    const unchanged = await repository.getProviderAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "bvnk",
    });
    if (unchanged === null) {
      throw new Error("Expected BVNK customer link");
    }
    expect(unchanged.metadata).toEqual({
      residenceCountryCode: "US",
      session: { reference: "bvnk_session_signed", agreements: [] },
    });
    expect(await repository.markCustomerLinkSessionTimestamp(input)).toMatchObject({
      metadata: {
        session: {
          reference: "bvnk_session_signed",
          signedAt: "2026-09-16T17:19:03.631Z",
        },
      },
    });
    expect(await repository.markCustomerLinkSessionTimestamp(input)).toBeNull();
  });

  it("CAS-marks agreement consent without replacing a recorded signature", async () => {
    const counterparty = await seedCounterparty("cpacc_session_consent");
    const otherCounterparty = await seedCounterparty("cpacc_session_consent_other");
    const seeded = await repository.upsertProviderAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "bvnk",
      providerCustomerReference: "cp_cpacc_session_consent",
      metadata: {
        residenceCountryCode: "US",
        session: {
          reference: "bvnk_session_consent",
          agreements: [],
          signedAt: "2026-09-16T17:19:03.631Z",
        },
      },
    });
    const input = {
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "bvnk" as const,
      id: seeded.id,
      sessionReference: "bvnk_session_consent",
      field: "consentSubmittedAt" as const,
      timestamp: "2026-09-16T17:20:03.631Z",
    };

    expect(
      await repository.markCustomerLinkSessionTimestamp({
        ...input,
        counterpartyId: otherCounterparty.id,
      })
    ).toBeNull();
    const unchanged = await repository.getProviderAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "bvnk",
    });
    if (unchanged === null) {
      throw new Error("Expected BVNK customer link");
    }
    expect(unchanged.metadata).toEqual({
      residenceCountryCode: "US",
      session: {
        reference: "bvnk_session_consent",
        agreements: [],
        signedAt: "2026-09-16T17:19:03.631Z",
      },
    });

    const updated = await repository.markCustomerLinkSessionTimestamp(input);
    if (updated === null) {
      throw new Error("Expected BVNK customer link consent submission");
    }
    expect(updated.metadata).toEqual({
      residenceCountryCode: "US",
      session: {
        reference: "bvnk_session_consent",
        agreements: [],
        signedAt: "2026-09-16T17:19:03.631Z",
        consentSubmittedAt: "2026-09-16T17:20:03.631Z",
      },
    });
    expect(await repository.markCustomerLinkSessionTimestamp(input)).toBeNull();
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
    ).toEqual([
      expect.objectContaining({ id: customer.id, kind: "customer_link" }),
      usd,
      expect.objectContaining({ id: gbp.id, status: "archived" }),
    ]);
    expect(
      await repository.listProviderAccounts({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        fiatCurrency: "USD",
        destinationCountry: "US",
      })
    ).toEqual([expect.objectContaining({ id: customer.id, kind: "customer_link" }), usd]);
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

describe("counterpartyProviderAccountUuid", () => {
  it("strips the prefix from a generated row id", () => {
    const id = generateCounterpartyProviderAccountId();
    expect(counterpartyProviderAccountUuid(id)).toBe(
      id.slice("counterparty_provider_account_".length)
    );
  });

  it("rejects ids that are not prefixed uuids", () => {
    expect(() => counterpartyProviderAccountUuid("cpa_archived_cpty_123")).toThrow();
    expect(() =>
      counterpartyProviderAccountUuid("counterparty_provider_account_not-a-uuid")
    ).toThrow();
    expect(() =>
      counterpartyProviderAccountUuid("other_prefix_2a9c8a29-5030-456d-87c2-7f6cc2ee6bf3")
    ).toThrow();
  });
});
