import { SDP_ENVIRONMENTS, type SdpEnvironment } from "@sdp/types/api-keys";
import { CLUSTER_BY_SDP_ENVIRONMENT, WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { seedProjectCryptoWalletCounterparty } from "@/test/helpers/counterparties";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import { seedUnreadPrivyWallet } from "@/test/helpers/custody-connections";
import { env } from "@/test/helpers/env";
import { CHECK_VIOLATION } from "@/test/helpers/migration-db";
import { seedRecurringDatabaseTenant, testSignature } from "@/test/helpers/recurring-payments";
import { required } from "@/test/helpers/required";
import { seedTestDatabase } from "@/test/mocks/db";
import { createPostgresCounterpartiesRepository } from "./counterparty.repository.postgres";
import { createPostgresCounterpartyAccountsRepository } from "./counterparty-account.repository.postgres";
import type {
  PaymentRecurringPaymentsRepository,
  RecurringPaymentStepSignatureSlot,
} from "./payment-recurring-payments.repository";
import { createPostgresPaymentRecurringPaymentsRepository } from "./payment-recurring-payments.repository.postgres";
import { createPostgresPaymentSubscriptionsRepository } from "./payment-subscriptions.repository.postgres";

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
    await seedTestCustodyRows(env, {
      configs: [
        {
          id: "cfg_recurring_payments_sibling",
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT_ID,
          provider: "privy",
          configEncrypted: "encrypted",
          status: "active",
        },
      ],
      wallets: [
        {
          id: TEST_SIBLING_CUSTODY_WALLET_ID,
          owner: { kind: "config", custodyConfigId: "cfg_recurring_payments_sibling" },
          walletId: TEST_PROVIDER_WALLET_ID,
          publicKey: TEST_SOURCE_ADDRESS,
          label: null,
          purpose: null,
          status: "active",
        },
      ],
    });

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
      idempotencyKey: null,
      idempotencyFingerprint: null,
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
      idempotencyKey: null,
      idempotencyFingerprint: null,
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
      })
    ).toEqual(before);
  });

  const PLAN_SLOT: RecurringPaymentStepSignatureSlot = {
    row: "activation_attempt",
    column: "plan_creation_signature",
  };
  const SETUP_SLOT: RecurringPaymentStepSignatureSlot = {
    row: "activation_attempt",
    column: "authorization_setup_signature",
  };
  const SIBLING_PROJECT_ID = `${TEST_PROJECT_ID}_production`;
  const STEP_UPDATED_AT = "2026-06-29T12:05:00.000Z";
  const UNSIGNED_SLOTS = {
    plan_creation_signature: null,
    authorization_setup_signature: null,
    last_valid_block_height: null,
  };

  async function createUnsignedActivationAttempt(attemptId: string) {
    const { account, counterparty } = await seedCounterpartyAccount();
    const createdAt = "2026-06-29T12:00:00.000Z";
    const created = required(
      await repo.createRecurringPayment({
        id: `recpay_${attemptId}`,
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
        idempotencyKey: null,
        idempotencyFingerprint: null,
      })
    );
    return required(
      await repo.createActivationAttempt({
        id: attemptId,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        recurringPaymentId: created.id,
        status: "processing",
        stage: "create_plan",
        planCreationSignature: null,
        authorizationSignature: null,
        error: null,
        metadata: {},
        createdAt,
        updatedAt: createdAt,
      })
    );
  }

  async function fillActivationSlots(
    attemptId: string,
    slots: {
      planCreationSignature: string | null;
      authorizationSetupSignature: string | null;
      lastValidBlockHeight: string | null;
    }
  ) {
    await getDb(env)
      .prepare(
        `UPDATE payment_recurring_payment_activation_attempts
            SET plan_creation_signature = ?,
                authorization_setup_signature = ?,
                last_valid_block_height = ?::numeric
          WHERE id = ?`
      )
      .bind(
        slots.planCreationSignature,
        slots.authorizationSetupSignature,
        slots.lastValidBlockHeight,
        attemptId
      )
      .run();
  }

  async function savedActivationSlots(attemptId: string) {
    return getDb(env)
      .prepare(
        `SELECT plan_creation_signature,
                authorization_setup_signature,
                last_valid_block_height::text AS last_valid_block_height
           FROM payment_recurring_payment_activation_attempts
          WHERE id = ?`
      )
      .bind(attemptId)
      .first<{
        plan_creation_signature: string | null;
        authorization_setup_signature: string | null;
        last_valid_block_height: string | null;
      }>();
  }

  it("clears a step's signature and expiry only while its slot still holds that signature", async () => {
    const attempt = await createUnsignedActivationAttempt("prpa_repo_clear_signature");
    await fillActivationSlots(attempt.id, {
      planCreationSignature: testSignature(1),
      authorizationSetupSignature: testSignature(3),
      lastValidBlockHeight: "301",
    });
    const clear = (input: {
      slot: RecurringPaymentStepSignatureSlot;
      projectId: string;
      signature: string;
    }) =>
      repo.clearStepSignature({
        ...input,
        id: attempt.id,
        organizationId: TEST_ORG.id,
        updatedAt: STEP_UPDATED_AT,
      });

    expect(
      await clear({ slot: PLAN_SLOT, projectId: TEST_PROJECT_ID, signature: testSignature(2) })
    ).toBe(false);
    expect(
      await clear({ slot: SETUP_SLOT, projectId: TEST_PROJECT_ID, signature: testSignature(1) })
    ).toBe(false);
    expect(
      await clear({ slot: PLAN_SLOT, projectId: SIBLING_PROJECT_ID, signature: testSignature(1) })
    ).toBe(false);
    expect(await savedActivationSlots(attempt.id)).toEqual({
      plan_creation_signature: testSignature(1),
      authorization_setup_signature: testSignature(3),
      last_valid_block_height: "301",
    });

    expect(
      await clear({ slot: PLAN_SLOT, projectId: TEST_PROJECT_ID, signature: testSignature(1) })
    ).toBe(true);
    expect(await savedActivationSlots(attempt.id)).toEqual({
      plan_creation_signature: null,
      authorization_setup_signature: testSignature(3),
      last_valid_block_height: null,
    });
    expect(
      await clear({ slot: SETUP_SLOT, projectId: TEST_PROJECT_ID, signature: testSignature(3) })
    ).toBe(true);
    expect(await savedActivationSlots(attempt.id)).toEqual(UNSIGNED_SLOTS);
  });

  describe("setStepSignature", () => {
    const setPlanSignature = (input: {
      id: string;
      projectId: string;
      signature: string;
      lastValidBlockHeight: string;
    }) =>
      repo.setStepSignature({
        ...input,
        slot: PLAN_SLOT,
        organizationId: TEST_ORG.id,
        updatedAt: STEP_UPDATED_AT,
      });

    it("saves the signature and its expiry into an empty slot", async () => {
      const attempt = await createUnsignedActivationAttempt("prpa_repo_set_signature");

      const saved = await setPlanSignature({
        id: attempt.id,
        projectId: TEST_PROJECT_ID,
        signature: testSignature(1),
        lastValidBlockHeight: "301",
      });

      expect(saved).toBe(true);
      expect(await savedActivationSlots(attempt.id)).toEqual({
        plan_creation_signature: testSignature(1),
        authorization_setup_signature: null,
        last_valid_block_height: "301",
      });
    });

    it.each([
      {
        refused: "a slot that already holds a signature",
        projectId: TEST_PROJECT_ID,
        held: {
          planCreationSignature: testSignature(1),
          authorizationSetupSignature: null,
          lastValidBlockHeight: "301",
        },
        expected: {
          plan_creation_signature: testSignature(1),
          authorization_setup_signature: null,
          last_valid_block_height: "301",
        },
      },
      {
        refused: "another project's write",
        projectId: SIBLING_PROJECT_ID,
        held: {
          planCreationSignature: null,
          authorizationSetupSignature: null,
          lastValidBlockHeight: null,
        },
        expected: UNSIGNED_SLOTS,
      },
    ])("refuses $refused and leaves the row unchanged", async ({ projectId, held, expected }) => {
      const attempt = await createUnsignedActivationAttempt("prpa_repo_set_signature_refused");
      await fillActivationSlots(attempt.id, held);

      const saved = await setPlanSignature({
        id: attempt.id,
        projectId,
        signature: testSignature(2),
        lastValidBlockHeight: "302",
      });

      expect(saved).toBe(false);
      expect(await savedActivationSlots(attempt.id)).toEqual(expected);
    });

    it("refuses a block height past u64 through the sdp_u64 domain", async () => {
      const attempt = await createUnsignedActivationAttempt("prpa_repo_set_signature_u64");

      await expect(
        setPlanSignature({
          id: attempt.id,
          projectId: TEST_PROJECT_ID,
          signature: testSignature(1),
          lastValidBlockHeight: "18446744073709551616",
        })
      ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint: "sdp_u64_check" });
      expect(await savedActivationSlots(attempt.id)).toEqual(UNSIGNED_SLOTS);
    });
  });
});

describe("PaymentRecurringPaymentsRepository collection job reads (postgres)", () => {
  const PROJECT_ID_BY_ENVIRONMENT = {
    sandbox: TEST_PROJECT_ID,
    production: `${TEST_PROJECT_ID}_production`,
  } as const satisfies Record<SdpEnvironment, string>;
  const SOURCE_WALLET_BY_ENVIRONMENT = {
    sandbox: { custodyWalletId: TEST_CUSTODY_WALLET_ID, walletId: TEST_PROVIDER_WALLET_ID },
    production: {
      custodyWalletId: "cwlt_recurring_payments_repo_production",
      walletId: "wallet_recurring_payments_repo_production",
    },
  } as const satisfies Record<SdpEnvironment, { custodyWalletId: string; walletId: string }>;
  const STALE_AT = "2026-06-29T12:00:00.000Z";
  const DUE_AT = "2026-06-30T12:00:00.000Z";
  const READ_AT = "2026-07-01T00:00:00.000Z";
  let repo: PaymentRecurringPaymentsRepository;

  function recurringPaymentId(environment: SdpEnvironment): string {
    return `recpay_repo_job_${environment}`;
  }

  function subscriptionId(environment: SdpEnvironment): string {
    return `psub_recurring_repo_job_${environment}`;
  }

  function usdcMint(environment: SdpEnvironment): string {
    return WELL_KNOWN_TOKENS.USDC.mints[CLUSTER_BY_SDP_ENVIRONMENT[environment]].address;
  }

  afterAll(async () => {
    await seedTestDatabase(env);
  });

  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);
    await seedRecurringDatabaseTenant({
      organizationId: TEST_ORG.id,
      organizationName: TEST_ORG.name,
      organizationSlug: TEST_ORG.slug,
      userId: TEST_USER.id,
      userEmail: TEST_USER.email,
      projectId: PROJECT_ID_BY_ENVIRONMENT.sandbox,
      custodyConfigId: "cfg_recurring_payments_job_reads",
      custodyWalletId: SOURCE_WALLET_BY_ENVIRONMENT.sandbox.custodyWalletId,
      providerWalletId: SOURCE_WALLET_BY_ENVIRONMENT.sandbox.walletId,
      publicKey: TEST_SOURCE_ADDRESS,
    });
    await seedUnreadPrivyWallet(db, {
      organizationId: TEST_ORG.id,
      projectId: PROJECT_ID_BY_ENVIRONMENT.production,
      createdBy: TEST_USER.id,
      custodyWalletId: SOURCE_WALLET_BY_ENVIRONMENT.production.custodyWalletId,
      walletId: SOURCE_WALLET_BY_ENVIRONMENT.production.walletId,
      publicKey: TEST_SOURCE_ADDRESS,
    });
    repo = createPostgresPaymentRecurringPaymentsRepository(db);
    const subscriptionsRepo = createPostgresPaymentSubscriptionsRepository(db);
    for (const environment of SDP_ENVIRONMENTS) {
      const projectId = PROJECT_ID_BY_ENVIRONMENT[environment];
      const sourceWallet = SOURCE_WALLET_BY_ENVIRONMENT[environment];
      const counterpartyId = `cpty_recurring_repo_job_${environment}`;
      const counterpartyAccountId = `cpa_recurring_repo_job_${environment}`;
      const planId = `psp_recurring_repo_job_${environment}`;
      await seedProjectCryptoWalletCounterparty(db, {
        organizationId: TEST_ORG.id,
        projectId,
        createdBy: TEST_USER.id,
        counterpartyId,
        counterpartyAccountId,
        walletAddress: "Destination111111111111111111111111111111",
      });
      await subscriptionsRepo.createPlan({
        id: planId,
        organizationId: TEST_ORG.id,
        projectId,
        ownerWalletId: sourceWallet.walletId,
        ownerAddress: TEST_SOURCE_ADDRESS,
        token: usdcMint(environment),
        amount: "10.00",
        periodHours: 24,
        programPlanId: "1",
        planPda: null,
        destinationAddress: "Destination111111111111111111111111111111",
        pullerWalletId: null,
        pullerAddress: null,
        metadataUri: null,
        status: "active",
        createdBy: TEST_USER.id,
        createdAt: STALE_AT,
        updatedAt: STALE_AT,
      });
      await subscriptionsRepo.createSubscription({
        id: subscriptionId(environment),
        organizationId: TEST_ORG.id,
        projectId,
        planId,
        counterpartyId,
        subscriberAddress: TEST_SOURCE_ADDRESS,
        subscriberTokenAccount: null,
        subscriptionPda: null,
        subscriptionAuthorityAddress: null,
        authorizationSignature: null,
        status: "active",
        currentPeriodStartAt: STALE_AT,
        nextCollectionDueAt: DUE_AT,
        createdBy: TEST_USER.id,
        createdAt: STALE_AT,
        updatedAt: STALE_AT,
      });
      await repo.createRecurringPayment({
        id: recurringPaymentId(environment),
        organizationId: TEST_ORG.id,
        projectId,
        sourceCustodyWalletId: sourceWallet.custodyWalletId,
        sourceWalletId: sourceWallet.walletId,
        sourceAddress: TEST_SOURCE_ADDRESS,
        counterpartyId,
        counterpartyAccountId,
        destinationAddress: "Destination111111111111111111111111111111",
        token: usdcMint(environment),
        amount: "10.00",
        periodHours: 24,
        firstCollectionAt: null,
        metadataUri: null,
        createdBy: TEST_USER.id,
        createdAt: STALE_AT,
        updatedAt: STALE_AT,
        idempotencyKey: null,
        idempotencyFingerprint: null,
      });
      await db
        .prepare(
          `UPDATE payment_recurring_payments
              SET status = 'active', plan_id = ?, subscription_id = ?, next_collection_due_at = ?
            WHERE id = ?`
        )
        .bind(planId, subscriptionId(environment), DUE_AT, recurringPaymentId(environment))
        .run();
    }
  });

  async function setBothStatuses(status: "activating" | "updating"): Promise<void> {
    await getDb(env).prepare("UPDATE payment_recurring_payments SET status = ?").bind(status).run();
  }

  const JOB_READS: readonly {
    read: string;
    prepare: () => Promise<void>;
    list: (environment: SdpEnvironment) => Promise<readonly { id: string }[]>;
  }[] = [
    {
      read: "listStaleLifecyclePayments",
      prepare: () => setBothStatuses("activating"),
      list: (environment) =>
        repo.listStaleLifecyclePayments({ environment, staleBefore: READ_AT, limit: 10 }),
    },
    {
      read: "listStaleUpdatePayments",
      prepare: () => setBothStatuses("updating"),
      list: (environment) =>
        repo.listStaleUpdatePayments({ environment, staleBefore: READ_AT, limit: 10 }),
    },
    {
      read: "listRecoverableCollectionPayments",
      prepare: async () => {
        for (const environment of SDP_ENVIRONMENTS) {
          await createPostgresPaymentSubscriptionsRepository(getDb(env)).createCollectionAttempt({
            id: `psca_recurring_repo_job_${environment}`,
            organizationId: TEST_ORG.id,
            projectId: PROJECT_ID_BY_ENVIRONMENT[environment],
            subscriptionId: subscriptionId(environment),
            transferId: null,
            token: usdcMint(environment),
            amount: "10.00",
            dueAt: DUE_AT,
            attemptedAt: STALE_AT,
            status: "processing",
            signature: null,
            error: null,
            metadata: {
              source: "automated",
              recurringPaymentId: recurringPaymentId(environment),
              initiatedByKeyId: null,
            },
            createdAt: STALE_AT,
            updatedAt: STALE_AT,
          });
        }
      },
      list: (environment) =>
        repo.listRecoverableCollectionPayments({ environment, staleBefore: READ_AT, limit: 10 }),
    },
    {
      read: "listDueCollectionPayments",
      prepare: async () => {},
      list: (environment) =>
        repo.listDueCollectionPayments({
          environment,
          dueBefore: READ_AT,
          retryBefore: READ_AT,
          limit: 10,
        }),
    },
  ];

  describe.each(JOB_READS)("$read", ({ prepare, list }) => {
    it.each(SDP_ENVIRONMENTS)("returns only the %s project's row", async (environment) => {
      await prepare();

      const rows = await list(environment);

      expect(rows.map((row) => row.id)).toEqual([recurringPaymentId(environment)]);
    });
  });
});
