import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedRecurringDatabaseTenant } from "@/test/helpers/recurring-payments";
import { seedTestDatabase } from "@/test/mocks/db";
import { createPostgresCounterpartiesRepository } from "./counterparty.repository.postgres";
import { createPostgresCounterpartyAccountsRepository } from "./counterparty-account.repository.postgres";
import type { PaymentRecurringPaymentsRepository } from "./payment-recurring-payments.repository";
import { createPostgresPaymentRecurringPaymentsRepository } from "./payment-recurring-payments.repository.postgres";

const TEST_PROJECT_ID = "prj_recurring_payments_repo_test";
const TEST_CUSTODY_WALLET_ID = "cwlt_recurring_payments_repo_test";
const TEST_SIBLING_CUSTODY_WALLET_ID = "cwlt_recurring_payments_repo_sibling";
const TEST_PROVIDER_WALLET_ID = "wallet_recurring_payments_repo_test";
const TEST_SOURCE_ADDRESS = "Sender111111111111111111111111111111111";

describe("PaymentRecurringPaymentsRepository (postgres)", () => {
  let repo: PaymentRecurringPaymentsRepository;

  beforeAll(async () => {
    await seedTestDatabase(env);
  });

  afterAll(async () => {
    await seedTestDatabase(env);
  });

  beforeEach(async () => {
    const db = getDb(env);
    await db.prepare("DELETE FROM payment_recurring_payment_update_events").run();
    await db.prepare("DELETE FROM payment_recurring_payment_update_attempts").run();
    await db.prepare("DELETE FROM payment_recurring_payments").run();
    await db.prepare("DELETE FROM counterparty_accounts").run();
    await db.prepare("DELETE FROM counterparties").run();
    await db.prepare("DELETE FROM projects").run();

    await seedRecurringDatabaseTenant({
      organizationId: TEST_ORG.id,
      organizationName: TEST_ORG.name,
      organizationSlug: TEST_ORG.slug,
      userId: TEST_USER.id,
      userEmail: TEST_USER.email,
      projectId: TEST_PROJECT_ID,
      custodyConfigId: "cfg_recurring_payments_exact",
      custodyWalletId: TEST_CUSTODY_WALLET_ID,
      providerWalletId: TEST_PROVIDER_WALLET_ID,
      publicKey: TEST_SOURCE_ADDRESS,
    });
    await db
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted)
         VALUES
           ('cfg_recurring_payments_exact', ?, NULL, 'test_recurring_exact', 'encrypted'),
           ('cfg_recurring_payments_sibling', ?, ?, 'test_recurring_sibling', 'encrypted')
         ON CONFLICT (id) DO NOTHING`
      )
      .bind(TEST_ORG.id, TEST_ORG.id, TEST_PROJECT_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key)
         VALUES
           (?, 'cfg_recurring_payments_exact', ?, ?),
           (?, 'cfg_recurring_payments_sibling', ?, ?)
         ON CONFLICT (id) DO NOTHING`
      )
      .bind(
        TEST_CUSTODY_WALLET_ID,
        TEST_PROVIDER_WALLET_ID,
        TEST_SOURCE_ADDRESS,
        TEST_SIBLING_CUSTODY_WALLET_ID,
        TEST_PROVIDER_WALLET_ID,
        TEST_SOURCE_ADDRESS
      )
      .run();

    repo = createPostgresPaymentRecurringPaymentsRepository(db);
  });

  async function seedCounterpartyAccount() {
    const counterpartiesRepo = createPostgresCounterpartiesRepository(getDb(env));
    const counterpartyAccountsRepo = createPostgresCounterpartyAccountsRepository(getDb(env));
    const counterparty = await counterpartiesRepo.createCounterparty({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      externalId: null,
      entityType: "individual",
      displayName: "Acme Recipient",
      providerData: {},
      createdBy: TEST_USER.id,
    });
    if (!counterparty) {
      throw new Error("failed to seed counterparty");
    }

    const account = await counterpartyAccountsRepo.createCounterpartyAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      accountKind: "crypto_wallet",
      label: "Acme Solana",
      details: { network: "solana", address: "Destination111111111111111111111111111111" },
    });
    if (!account) {
      throw new Error("failed to seed counterparty account");
    }

    return { account, counterparty };
  }

  it("persists exact source identities and authorizes Provider IDs only for legacy rows", async () => {
    const { account, counterparty } = await seedCounterpartyAccount();
    const createdAt = "2026-06-29T12:00:00.000Z";
    const create = (id: string, sourceCustodyWalletId: string) =>
      repo.createRecurringPayment({
        id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        sourceCustodyWalletId,
        sourceWalletId: TEST_PROVIDER_WALLET_ID,
        sourceAddress: TEST_SOURCE_ADDRESS,
        counterpartyId: counterparty.id,
        counterpartyAccountId: account.id,
        destinationAddress: "Destination111111111111111111111111111111",
        token: "USDC",
        amount: "10.00",
        periodHours: 24,
        firstCollectionAt: null,
        metadataUri: null,
        createdBy: TEST_USER.id,
        createdAt,
        updatedAt: createdAt,
      });

    const exact = await create("recpay_repo_exact_filter", TEST_CUSTODY_WALLET_ID);
    expect(exact).not.toBeNull();
    if (exact === null) throw new Error("Failed to create recurring payment");
    await create("recpay_repo_legacy_filter", TEST_CUSTODY_WALLET_ID);
    await create("recpay_repo_sibling_filter", TEST_SIBLING_CUSTODY_WALLET_ID);
    await getDb(env)
      .prepare(
        `UPDATE payment_recurring_payments
            SET source_custody_wallet_id = NULL
          WHERE id = 'recpay_repo_legacy_filter'`
      )
      .run();

    const attempt = await repo.createUpdateAttempt({
      id: "recpay_update_exact_source",
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      recurringPaymentId: exact.id,
      mode: "replacement",
      status: "processing",
      stage: "claim",
      oldPlanId: null,
      oldSubscriptionId: null,
      newPlanId: null,
      newSubscriptionId: null,
      newSourceCustodyWalletId: TEST_SIBLING_CUSTODY_WALLET_ID,
      planUpdateSignature: null,
      planCreationSignature: null,
      authorizationSetupSignature: null,
      authorizationSignature: null,
      oldCancelSignature: null,
      changedFields: ["sourceCustodyWalletId"],
      beforeValues: {},
      afterValues: { sourceCustodyWalletId: TEST_SIBLING_CUSTODY_WALLET_ID },
      error: null,
      createdBy: TEST_USER.id,
      createdAt,
      updatedAt: createdAt,
    });
    const authorized = await repo.listRecurringPayments({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      walletAuthorization: {
        custodyWalletIds: [TEST_CUSTODY_WALLET_ID],
        providerWalletIds: [TEST_PROVIDER_WALLET_ID],
      },
      limit: 20,
      offset: 0,
    });

    expect(attempt).not.toBeNull();
    if (attempt === null) throw new Error("Failed to create recurring payment update attempt");
    expect(exact.source_custody_wallet_id).toBe(TEST_CUSTODY_WALLET_ID);
    expect(attempt.new_source_custody_wallet_id).toBe(TEST_SIBLING_CUSTODY_WALLET_ID);
    expect(authorized.rows.map((row) => row.id).sort()).toEqual([
      "recpay_repo_exact_filter",
      "recpay_repo_legacy_filter",
    ]);
    await expect(
      repo.getRecurringPaymentById({
        recurringPaymentId: "recpay_repo_sibling_filter",
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        walletAuthorization: {
          custodyWalletIds: [TEST_CUSTODY_WALLET_ID],
          providerWalletIds: [TEST_PROVIDER_WALLET_ID],
        },
      })
    ).resolves.toBeNull();

    const promoted = await repo.updateRecurringPayment({
      recurringPaymentId: exact.id,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      sourceCustodyWalletId: TEST_SIBLING_CUSTODY_WALLET_ID,
      sourceWalletId: TEST_PROVIDER_WALLET_ID,
      sourceAddress: TEST_SOURCE_ADDRESS,
      expectedStatus: "pending_activation",
      updatedAt: "2026-06-29T12:01:00.000Z",
    });
    expect(promoted).not.toBeNull();
    if (promoted === null) throw new Error("Failed to update recurring payment");
    expect(promoted.source_custody_wallet_id).toBe(TEST_SIBLING_CUSTODY_WALLET_ID);
  });

  it("guards pending updates with the expected updated_at value", async () => {
    const { account, counterparty } = await seedCounterpartyAccount();
    const createdAt = "2026-06-29T12:00:00.000Z";
    const created = await repo.createRecurringPayment({
      id: "recpay_repo_guard",
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      sourceWalletId: "wallet_sender",
      sourceAddress: "Sender111111111111111111111111111111111",
      counterpartyId: counterparty.id,
      counterpartyAccountId: account.id,
      destinationAddress: "Destination111111111111111111111111111111",
      token: "USDC",
      amount: "10.00",
      periodHours: 24,
      firstCollectionAt: null,
      metadataUri: null,
      createdBy: TEST_USER.id,
      createdAt,
      updatedAt: createdAt,
    });
    expect(created).not.toBeNull();
    if (created === null) throw new Error("Failed to create recurring payment");

    const staleUpdate = await repo.updateRecurringPayment({
      recurringPaymentId: created.id,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      amount: "20.00",
      expectedStatus: "pending_activation",
      expectedUpdatedAt: "2026-06-29T11:59:59.000Z",
      updatedAt: "2026-06-29T12:01:00.000Z",
    });

    expect(staleUpdate).toBeNull();

    const updated = await repo.updateRecurringPayment({
      recurringPaymentId: created.id,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      amount: "20.00",
      expectedStatus: "pending_activation",
      expectedUpdatedAt: created.updated_at,
      updatedAt: "2026-06-29T12:01:00.000Z",
    });

    expect(updated).not.toBeNull();
    if (updated === null) throw new Error("Failed to update recurring payment");
    expect(updated.amount).toBe("20.00");
  });

  it("does not activate a canceled recurring payment with a stale activation writer", async () => {
    const { account, counterparty } = await seedCounterpartyAccount();
    const createdAt = "2026-06-29T12:00:00.000Z";
    const created = await repo.createRecurringPayment({
      id: "recpay_repo_stale_activation",
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      sourceWalletId: TEST_PROVIDER_WALLET_ID,
      sourceAddress: TEST_SOURCE_ADDRESS,
      counterpartyId: counterparty.id,
      counterpartyAccountId: account.id,
      destinationAddress: "Destination111111111111111111111111111111",
      token: "USDC",
      amount: "10.00",
      periodHours: 24,
      firstCollectionAt: null,
      metadataUri: null,
      createdBy: TEST_USER.id,
      createdAt,
      updatedAt: createdAt,
    });
    expect(created).not.toBeNull();
    if (created === null) throw new Error("Failed to create recurring payment");
    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET status = 'canceled' WHERE id = ?")
      .bind(created.id)
      .run();
    const before = await repo.getRecurringPaymentById({
      recurringPaymentId: created.id,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      walletAuthorization: null,
    });

    const updated = await repo.updateRecurringPaymentActivation({
      recurringPaymentId: created.id,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      status: "active",
      planId: "psp_stale",
      subscriptionId: "psub_stale",
      updatedAt: "2026-06-29T12:01:00.000Z",
    });

    expect(updated).toBeNull();
    expect(
      await repo.getRecurringPaymentById({
        recurringPaymentId: created.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        walletAuthorization: null,
      })
    ).toEqual(before);
  });
});
