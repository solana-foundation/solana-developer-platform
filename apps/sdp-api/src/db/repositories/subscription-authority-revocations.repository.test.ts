import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { refuseWhileSubscriptionAuthorityRevokes } from "@/services/payments/recurring-payments/shared";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedRecurringDatabaseTenant } from "@/test/helpers/recurring-payments";
import { required } from "@/test/helpers/required";
import { seedTestDatabase } from "@/test/mocks/db";
import { createPostgresCounterpartiesRepository } from "./counterparty.repository.postgres";
import { createPostgresCounterpartyAccountsRepository } from "./counterparty-account.repository.postgres";
import { createPostgresPaymentRecurringPaymentsRepository } from "./payment-recurring-payments.repository.postgres";
import {
  createPostgresSubscriptionAuthorityRevocationsRepository,
  type SubscriptionAuthorityRevocationsRepository,
} from "./subscription-authority-revocations.repository";

const PROJECT_ID = "prj_authority_revocations_test";
const CUSTODY_WALLET_ID = "cwlt_authority_revocations_test";
const WALLET = "Sender111111111111111111111111111111111";
const AUTHORITY = "Authority1111111111111111111111111111111";
const OTHER_AUTHORITY = "Authority2222222222222222222222222222222";
const MINT = "Mint111111111111111111111111111111111111";
const NOW = "2026-10-21T12:00:00.000Z";
const RETRY_FAILED_BEFORE = "2026-10-21T06:00:00.000Z";
/** A period-24 schedule last changed this long ago is idle: 24h period + 1h margin, plus slack. */
const LONG_AGO = "2026-10-19T12:00:00.000Z";
/** Inside the 24h period plus margin, so a canceled subscription may still be resumed. */
const RECENTLY = "2026-10-21T00:00:00.000Z";

describe("SubscriptionAuthorityRevocationsRepository (postgres)", () => {
  let repo: SubscriptionAuthorityRevocationsRepository;
  let counterpartyId: string;
  let counterpartyAccountId: string;
  let sequence = 0;

  beforeAll(async () => {
    await seedTestDatabase(env);
  });

  afterAll(async () => {
    await seedTestDatabase(env);
  });

  beforeEach(async () => {
    const db = getDb(env);
    await db.prepare("DELETE FROM payment_subscription_authority_revocations").run();
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
      projectId: PROJECT_ID,
      custodyConfigId: "cfg_authority_revocations_test",
      custodyWalletId: CUSTODY_WALLET_ID,
      providerWalletId: "wallet_authority_revocations_test",
      publicKey: WALLET,
    });
    const counterparty = required(
      await createPostgresCounterpartiesRepository(db).createCounterparty({
        organizationId: TEST_ORG.id,
        projectId: PROJECT_ID,
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
        projectId: PROJECT_ID,
        counterpartyId: counterparty.id,
        accountKind: "crypto_wallet",
        label: "Recipient Solana",
        details: { network: "solana", address: "Destination111111111111111111111111111111" },
      })
    );
    counterpartyId = counterparty.id;
    counterpartyAccountId = account.id;
    repo = createPostgresSubscriptionAuthorityRevocationsRepository(db);
  });

  /** A period-24 recurring payment on WALLET in `status`, last changed at `updatedAt`. */
  async function seedRecurringPayment(input: {
    status: string;
    updatedAt: string;
    authority?: string | null;
  }): Promise<string> {
    sequence += 1;
    const id = `recpay_authority_${sequence}`;
    const db = getDb(env);
    required(
      await createPostgresPaymentRecurringPaymentsRepository(db).createRecurringPayment({
        id,
        organizationId: TEST_ORG.id,
        projectId: PROJECT_ID,
        sourceCustodyWalletId: CUSTODY_WALLET_ID,
        sourceWalletId: "wallet_authority_revocations_test",
        sourceAddress: WALLET,
        counterpartyId,
        counterpartyAccountId,
        destinationAddress: "Destination111111111111111111111111111111",
        token: MINT,
        amount: "10.00",
        periodHours: 24,
        firstCollectionAt: null,
        metadataUri: null,
        createdBy: TEST_USER.id,
        createdAt: input.updatedAt,
        updatedAt: input.updatedAt,
        idempotencyKey: null,
        idempotencyFingerprint: null,
      })
    );
    await db.execute(
      `UPDATE payment_recurring_payments
          SET status = ?, subscription_authority_address = ?, updated_at = ?
        WHERE id = ?`,
      [
        input.status,
        input.authority === undefined ? AUTHORITY : input.authority,
        input.updatedAt,
        id,
      ]
    );
    return id;
  }

  function list() {
    return repo.listRevocableAuthorities({
      environment: "sandbox",
      idleBefore: NOW,
      retryFailedBefore: RETRY_FAILED_BEFORE,
      limit: 25,
    });
  }

  function claim(id: string, authority = AUTHORITY) {
    return getDb(env).transaction(async (tx) => {
      const transactionRepo = createPostgresSubscriptionAuthorityRevocationsRepository(tx);
      await transactionRepo.lockWalletAuthorities(WALLET);
      return transactionRepo.claimRevocation({
        id,
        organizationId: TEST_ORG.id,
        projectId: PROJECT_ID,
        environment: "sandbox",
        custodyWalletId: CUSTODY_WALLET_ID,
        walletAddress: WALLET,
        tokenMint: MINT,
        subscriptionAuthorityAddress: authority,
        idleBefore: NOW,
        retryFailedBefore: RETRY_FAILED_BEFORE,
        now: NOW,
      });
    });
  }

  it("offers an authority once its only schedule was canceled more than a period ago", async () => {
    await seedRecurringPayment({ status: "canceled", updatedAt: LONG_AGO });

    expect(await list()).toEqual([
      {
        organization_id: TEST_ORG.id,
        project_id: PROJECT_ID,
        custody_wallet_id: CUSTODY_WALLET_ID,
        wallet_address: WALLET,
        token: MINT,
        subscription_authority_address: AUTHORITY,
      },
    ]);
  });

  it("keeps an authority while a canceled schedule on it is still inside its billing period", async () => {
    await seedRecurringPayment({ status: "canceled", updatedAt: RECENTLY });

    expect(await list()).toEqual([]);
    expect(await claim("psar_recent")).toBeNull();
  });

  it("keeps an authority while any other schedule on it is live", async () => {
    await seedRecurringPayment({ status: "canceled", updatedAt: LONG_AGO });
    // Canceling, still on chain: any status but canceled and expired holds the authority.
    await seedRecurringPayment({ status: "canceling", updatedAt: LONG_AGO });

    expect(await list()).toEqual([]);
    expect(await claim("psar_live")).toBeNull();
  });

  it("keeps every authority on a wallet while a schedule on it is activating, updating or resuming", async () => {
    await seedRecurringPayment({ status: "canceled", updatedAt: LONG_AGO });
    for (const status of ["activating", "updating", "resuming"]) {
      const inFlight = await seedRecurringPayment({ status, updatedAt: NOW, authority: null });
      expect(await list()).toEqual([]);
      await getDb(env).execute("DELETE FROM payment_recurring_payments WHERE id = ?", [inFlight]);
    }
    expect(await list()).toHaveLength(1);
  });

  it("holds one revoke in flight per authority and offers it again only after a later change", async () => {
    const recurringPaymentId = await seedRecurringPayment({
      status: "canceled",
      updatedAt: LONG_AGO,
    });

    const claimed = required(await claim("psar_first"));
    expect(claimed.status).toBe("processing");
    expect(await claim("psar_second")).toBeNull();
    expect(await list()).toEqual([]);

    await repo.finish({ id: claimed.id, status: "confirmed", error: null, updatedAt: NOW });
    expect(await list()).toEqual([]);

    // Resumed and canceled again after the revoke: the next cancel's period starts over.
    await getDb(env).execute("UPDATE payment_recurring_payments SET updated_at = ? WHERE id = ?", [
      "2026-10-21T12:00:01.000Z",
      recurringPaymentId,
    ]);
    expect(
      await repo.listRevocableAuthorities({
        environment: "sandbox",
        idleBefore: "2026-10-23T12:00:00.000Z",
        retryFailedBefore: RETRY_FAILED_BEFORE,
        limit: 25,
      })
    ).toHaveLength(1);
  });

  it("waits out the retry window after a failed revoke", async () => {
    await seedRecurringPayment({ status: "canceled", updatedAt: LONG_AGO });
    const claimed = required(await claim("psar_failed"));
    await repo.finish({ id: claimed.id, status: "failed", error: "refused", updatedAt: NOW });

    expect(await list()).toEqual([]);
    expect(
      await repo.listRevocableAuthorities({
        environment: "sandbox",
        idleBefore: NOW,
        retryFailedBefore: "2026-10-21T12:00:01.000Z",
        limit: 25,
      })
    ).toHaveLength(1);
  });

  it("refuses an activation, update or resume claim on the wallet while a revoke is in flight", async () => {
    await seedRecurringPayment({ status: "canceled", updatedAt: LONG_AGO });
    await seedRecurringPayment({
      status: "canceled",
      updatedAt: LONG_AGO,
      authority: OTHER_AUTHORITY,
    });
    const claimed = required(await claim("psar_guard"));
    const guard = () =>
      getDb(env).transaction((tx) =>
        refuseWhileSubscriptionAuthorityRevokes(tx, {
          projectId: PROJECT_ID,
          custodyWalletIds: [CUSTODY_WALLET_ID],
        })
      );

    expect(
      await repo.hasRevocationInFlight({ environment: "sandbox", walletAddress: WALLET })
    ).toBe(true);
    await expect(guard()).rejects.toMatchObject({ code: "CONFLICT" });
    // Another mint's authority on the wallet can be revoked alongside, and the claim guard waits
    // for both: an activation may not know its mint's authority yet.
    expect(await claim("psar_other", OTHER_AUTHORITY)).not.toBeNull();

    await repo.finish({ id: claimed.id, status: "confirmed", error: null, updatedAt: NOW });
    await expect(guard()).rejects.toMatchObject({ code: "CONFLICT" });
    await getDb(env).execute(
      "UPDATE payment_subscription_authority_revocations SET status = 'confirmed' WHERE id = 'psar_other'"
    );
    await expect(guard()).resolves.toBeUndefined();
  });

  it("saves a send before broadcast and clears it only while the row still holds it", async () => {
    await seedRecurringPayment({ status: "canceled", updatedAt: LONG_AGO });
    const claimed = required(await claim("psar_send"));

    const saved = required(
      await repo.saveSend({
        id: claimed.id,
        signature: "sig_saved",
        lastValidBlockHeight: "18446744073709551615",
        updatedAt: NOW,
      })
    );
    expect(saved.last_valid_block_height).toBe("18446744073709551615");
    expect(await repo.clearSend({ id: claimed.id, signature: "sig_other", updatedAt: NOW })).toBe(
      false
    );
    expect(await repo.clearSend({ id: claimed.id, signature: "sig_saved", updatedAt: NOW })).toBe(
      true
    );
  });

  it("takes over only revokes left in flight past the stale window, once each", async () => {
    await seedRecurringPayment({ status: "canceled", updatedAt: LONG_AGO });
    const claimed = required(await claim("psar_stale"));
    await getDb(env).execute(
      "UPDATE payment_subscription_authority_revocations SET updated_at = ? WHERE id = ?",
      ["2026-10-21T11:00:00.000Z", claimed.id]
    );

    const staleInput = {
      environment: "sandbox" as const,
      staleBefore: "2026-10-21T11:45:00.000Z",
      now: NOW,
      limit: 25,
    };
    expect((await repo.claimStaleRevocations(staleInput)).map((row) => row.id)).toEqual([
      claimed.id,
    ]);
    expect(await repo.claimStaleRevocations(staleInput)).toEqual([]);
  });
});
