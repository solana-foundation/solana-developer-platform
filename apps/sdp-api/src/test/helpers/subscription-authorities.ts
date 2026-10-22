import type { PaymentRecurringPaymentStatus, PaymentSubscriptionStatus } from "@sdp/types/payments";
import { getDb } from "@/db/client";
import { createPostgresCounterpartiesRepository } from "@/db/repositories/counterparty.repository.postgres";
import { createPostgresCounterpartyAccountsRepository } from "@/db/repositories/counterparty-account.repository.postgres";
import { createPostgresPaymentRecurringPaymentsRepository } from "@/db/repositories/payment-recurring-payments.repository.postgres";
import { createPostgresPaymentSubscriptionsRepository } from "@/db/repositories/payment-subscriptions.repository.postgres";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedRecurringDatabaseTenant } from "@/test/helpers/recurring-payments";
import { required } from "@/test/helpers/required";

/**
 * Seeds for the Subscriptions authority cleanup (HOO-2210): a project with one custody wallet, and
 * subscriptions on that wallet's authority as recurring payments record them.
 */

export interface SubscriptionAuthorityTenant {
  projectId: string;
  custodyWalletId: string;
  providerWalletId: string;
  walletAddress: string;
  counterpartyId: string;
  counterpartyAccountId: string;
}

/** Clears the cleanup's tables and seeds the tenant, its custody wallet and a counterparty. */
export async function seedSubscriptionAuthorityTenant(
  tenant: Omit<SubscriptionAuthorityTenant, "counterpartyId" | "counterpartyAccountId">
): Promise<SubscriptionAuthorityTenant> {
  const db = getDb(env);
  for (const table of [
    "payment_subscription_authority_revocations",
    "payment_recurring_payment_update_attempts",
    "payment_recurring_payments",
    "payment_subscriptions",
    "payment_subscription_plans",
    "counterparty_accounts",
    "counterparties",
    "projects",
  ]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await seedRecurringDatabaseTenant({
    organizationId: TEST_ORG.id,
    organizationName: TEST_ORG.name,
    organizationSlug: TEST_ORG.slug,
    userId: TEST_USER.id,
    userEmail: TEST_USER.email,
    projectId: tenant.projectId,
    custodyConfigId: `cfg_${tenant.custodyWalletId}`,
    custodyWalletId: tenant.custodyWalletId,
    providerWalletId: tenant.providerWalletId,
    publicKey: tenant.walletAddress,
  });
  const counterparty = required(
    await createPostgresCounterpartiesRepository(db).createCounterparty({
      organizationId: TEST_ORG.id,
      projectId: tenant.projectId,
      externalId: null,
      entityType: "individual",
      displayName: "Recipient",
      providerData: {},
      createdBy: TEST_USER.id,
    })
  );
  const account = required(
    await createPostgresCounterpartyAccountsRepository(db).createCounterpartyAccount({
      organizationId: TEST_ORG.id,
      projectId: tenant.projectId,
      counterpartyId: counterparty.id,
      accountKind: "crypto_wallet",
      label: "Recipient Solana",
      details: { network: "solana", address: "Destination111111111111111111111111111111" },
    })
  );
  return { ...tenant, counterpartyId: counterparty.id, counterpartyAccountId: account.id };
}

let sequence = 0;

/**
 * A period-24 subscription from the tenant's wallet on `authority`, last changed at `changedAt`
 * (its cancel time when canceled), and the recurring payment it belongs to unless `recurring` is
 * null. Returns the subscription and recurring payment ids.
 */
export async function seedAuthoritySubscription(
  tenant: SubscriptionAuthorityTenant,
  input: {
    authority: string;
    tokenMint: string;
    status: PaymentSubscriptionStatus;
    changedAt: string;
    recurring: { status: PaymentRecurringPaymentStatus } | null;
  }
): Promise<{ subscriptionId: string; recurringPaymentId: string | null }> {
  sequence += 1;
  const db = getDb(env);
  const subscriptions = createPostgresPaymentSubscriptionsRepository(db);
  const plan = required(
    await subscriptions.createPlan({
      id: `plan_authority_${sequence}`,
      organizationId: TEST_ORG.id,
      projectId: tenant.projectId,
      ownerWalletId: tenant.providerWalletId,
      ownerAddress: tenant.walletAddress,
      token: input.tokenMint,
      amount: "1",
      periodHours: 24,
      programPlanId: String(sequence),
      planPda: null,
      destinationAddress: null,
      pullerWalletId: null,
      pullerAddress: null,
      metadataUri: null,
      status: "active",
      createdBy: TEST_USER.id,
      createdAt: input.changedAt,
      updatedAt: input.changedAt,
    })
  );
  const subscription = required(
    await subscriptions.createSubscription({
      id: `sub_authority_${sequence}`,
      organizationId: TEST_ORG.id,
      projectId: tenant.projectId,
      planId: plan.id,
      counterpartyId: tenant.counterpartyId,
      subscriberAddress: tenant.walletAddress,
      subscriberTokenAccount: null,
      subscriptionPda: null,
      subscriptionAuthorityAddress: input.authority,
      authorizationSignature: null,
      status: input.status,
      currentPeriodStartAt: null,
      nextCollectionDueAt: null,
      createdBy: TEST_USER.id,
      createdAt: input.changedAt,
      updatedAt: input.changedAt,
    })
  );
  await db.execute(
    "UPDATE payment_subscriptions SET canceled_at = ?, updated_at = ? WHERE id = ?",
    [input.status === "canceled" ? input.changedAt : null, input.changedAt, subscription.id]
  );
  if (input.recurring === null) {
    return { subscriptionId: subscription.id, recurringPaymentId: null };
  }

  const recurringPaymentId = `recpay_authority_${sequence}`;
  required(
    await createPostgresPaymentRecurringPaymentsRepository(db).createRecurringPayment({
      id: recurringPaymentId,
      organizationId: TEST_ORG.id,
      projectId: tenant.projectId,
      sourceCustodyWalletId: tenant.custodyWalletId,
      sourceWalletId: tenant.providerWalletId,
      sourceAddress: tenant.walletAddress,
      counterpartyId: tenant.counterpartyId,
      counterpartyAccountId: tenant.counterpartyAccountId,
      destinationAddress: "Destination111111111111111111111111111111",
      token: input.tokenMint,
      amount: "1",
      periodHours: 24,
      firstCollectionAt: null,
      metadataUri: null,
      createdBy: TEST_USER.id,
      createdAt: input.changedAt,
      updatedAt: input.changedAt,
      idempotencyKey: null,
      idempotencyFingerprint: null,
    })
  );
  await db.execute(
    `UPDATE payment_recurring_payments
        SET status = ?, subscription_authority_address = ?, updated_at = ?
      WHERE id = ?`,
    [input.recurring.status, input.authority, input.changedAt, recurringPaymentId]
  );
  return { subscriptionId: subscription.id, recurringPaymentId };
}
