import {
  IN_FLIGHT_RECURRING_PAYMENT_ATTEMPT_STATUSES,
  RECURRING_PAYMENT_STATUSES_CLAIMING_AUTHORITY,
} from "@sdp/types/payments";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { refuseWhileSubscriptionAuthorityRevokes } from "@/services/payments/recurring-payments/shared";
import { TEST_ORG } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { required } from "@/test/helpers/required";
import {
  type SubscriptionAuthorityTenant,
  seedAuthoritySubscription,
  seedSubscriptionAuthorityTenant,
} from "@/test/helpers/subscription-authorities";
import { seedTestDatabase } from "@/test/mocks/db";
import {
  createPostgresSubscriptionAuthorityRevocationsRepository,
  type SubscriptionAuthorityRevocationsRepository,
} from "./subscription-authority-revocations.repository";

const WALLET = "Sender111111111111111111111111111111111";
const AUTHORITY = "Authority1111111111111111111111111111111";
const OTHER_AUTHORITY = "Authority2222222222222222222222222222222";
const MINT = "Mint111111111111111111111111111111111111";
const NOW = "2026-10-21T12:00:00.000Z";
const RETRY_FAILED_BEFORE = "2026-10-21T06:00:00.000Z";
/** Past a period-24 subscription's 24h period plus the 1h margin. */
const LONG_AGO = "2026-10-19T12:00:00.000Z";
/** Inside the period plus margin, so a canceled subscription may still be resumed. */
const RECENTLY = "2026-10-21T00:00:00.000Z";

describe("SubscriptionAuthorityRevocationsRepository (postgres)", () => {
  let repo: SubscriptionAuthorityRevocationsRepository;
  let tenant: SubscriptionAuthorityTenant;

  beforeAll(async () => {
    await seedTestDatabase(env);
  });

  afterAll(async () => {
    await seedTestDatabase(env);
  });

  beforeEach(async () => {
    tenant = await seedSubscriptionAuthorityTenant({
      projectId: "prj_authority_revocations_test",
      custodyWalletId: "cwlt_authority_revocations_test",
      providerWalletId: "wallet_authority_revocations_test",
      walletAddress: WALLET,
    });
    repo = createPostgresSubscriptionAuthorityRevocationsRepository(getDb(env));
  });

  function canceledSchedule(changedAt = LONG_AGO, authority = AUTHORITY) {
    return seedAuthoritySubscription(tenant, {
      authority,
      tokenMint: MINT,
      status: "canceled",
      changedAt,
      recurring: { status: "canceled" },
    });
  }

  function list(idleBefore = NOW, retryFailedBefore = RETRY_FAILED_BEFORE) {
    return repo.listRevocableAuthorities({
      environment: "sandbox",
      idleBefore,
      retryFailedBefore,
      limit: 25,
    });
  }

  function claim(id: string, authority = AUTHORITY) {
    return getDb(env).transaction(async (tx) => {
      const transactionRepo = createPostgresSubscriptionAuthorityRevocationsRepository(tx);
      await transactionRepo.lockWalletAuthorities(WALLET);
      return transactionRepo.claimRevocation({
        id,
        leaseId: `lease_${id}`,
        organizationId: TEST_ORG.id,
        projectId: tenant.projectId,
        environment: "sandbox",
        custodyWalletId: tenant.custodyWalletId,
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
    await canceledSchedule();

    expect(await list()).toEqual([
      {
        organization_id: TEST_ORG.id,
        project_id: tenant.projectId,
        custody_wallet_id: tenant.custodyWalletId,
        wallet_address: WALLET,
        token: MINT,
        subscription_authority_address: AUTHORITY,
      },
    ]);
  });

  it("offers an authority an update left behind when it moved the schedule's wallet or token", async () => {
    // The recurring payment now names another authority; only its old subscription names this one.
    await seedAuthoritySubscription(tenant, {
      authority: AUTHORITY,
      tokenMint: MINT,
      status: "canceled",
      changedAt: LONG_AGO,
      recurring: null,
    });

    expect((await list()).map((row) => row.subscription_authority_address)).toEqual([AUTHORITY]);
  });

  it("releases a subscription left awaiting authorization once nothing can still authorize it", async () => {
    const { recurringPaymentId } = await canceledSchedule();
    const pending = await seedAuthoritySubscription(tenant, {
      authority: AUTHORITY,
      tokenMint: MINT,
      status: "pending_authorization",
      changedAt: LONG_AGO,
      recurring: null,
    });
    await getDb(env).execute(
      `INSERT INTO payment_recurring_payment_update_attempts (
         id, organization_id, project_id, recurring_payment_id, mode, status, stage,
         new_subscription_id)
       VALUES ('rpua_replacement', ?, ?, ?, 'replacement', 'processing', 'authorize_subscription', ?)`,
      [TEST_ORG.id, tenant.projectId, required(recurringPaymentId), pending.subscriptionId]
    );

    // The replacement update is still in flight: its authorization may land.
    expect(await list()).toEqual([]);

    // A live recurring payment still names it as its subscription.
    await getDb(env).execute(
      "UPDATE payment_recurring_payment_update_attempts SET status = 'failed' WHERE id = 'rpua_replacement'"
    );
    await getDb(env).execute(
      "UPDATE payment_recurring_payments SET status = 'pending_activation', subscription_id = ? WHERE id = ?",
      [pending.subscriptionId, required(recurringPaymentId)]
    );
    expect(await list()).toEqual([]);

    // The update failed and the payment that named it was canceled: nothing can authorize it.
    await getDb(env).execute(
      "UPDATE payment_recurring_payments SET status = 'canceled' WHERE id = ?",
      [required(recurringPaymentId)]
    );
    expect((await list()).map((row) => row.subscription_authority_address)).toEqual([AUTHORITY]);
  });

  it("keeps an authority a standalone subscription awaiting authorization may be using", async () => {
    await canceledSchedule();
    // From the subscriptions API: no recurring payment or update names it, and its row stays
    // pending after the caller's authorization lands.
    await seedAuthoritySubscription(tenant, {
      authority: AUTHORITY,
      tokenMint: MINT,
      status: "pending_authorization",
      changedAt: LONG_AGO,
      recurring: null,
    });

    expect(await list()).toEqual([]);
  });

  it("keeps an authority while a canceled schedule on it is still inside its billing period", async () => {
    await canceledSchedule(RECENTLY);

    expect(await list()).toEqual([]);
    expect(await claim("psar_recent")).toBeNull();
  });

  it("keeps an authority while any other subscription or recurring payment on it is live", async () => {
    await canceledSchedule();
    const live = await seedAuthoritySubscription(tenant, {
      authority: AUTHORITY,
      tokenMint: MINT,
      status: "active",
      changedAt: LONG_AGO,
      recurring: null,
    });
    expect(await list()).toEqual([]);

    await getDb(env).execute("UPDATE payment_subscriptions SET status = 'canceled' WHERE id = ?", [
      live.subscriptionId,
    ]);
    // A recurring payment still canceling holds it too, whatever its subscription says.
    await seedAuthoritySubscription(tenant, {
      authority: AUTHORITY,
      tokenMint: MINT,
      status: "canceled",
      changedAt: LONG_AGO,
      recurring: { status: "canceling" },
    });
    expect(await list()).toEqual([]);
    expect(await claim("psar_live")).toBeNull();
  });

  it("keeps every authority on a wallet while a schedule on it may be about to use one", async () => {
    const { recurringPaymentId } = await canceledSchedule();
    const id = required(recurringPaymentId);
    for (const status of RECURRING_PAYMENT_STATUSES_CLAIMING_AUTHORITY) {
      const claiming = await seedAuthoritySubscription(tenant, {
        authority: OTHER_AUTHORITY,
        tokenMint: MINT,
        status: "pending_authorization",
        changedAt: NOW,
        recurring: { status },
      });
      await getDb(env).execute(
        "UPDATE payment_recurring_payments SET subscription_authority_address = NULL WHERE id = ?",
        [required(claiming.recurringPaymentId)]
      );
      expect(await list()).toEqual([]);
      await getDb(env).execute("DELETE FROM payment_recurring_payments WHERE id = ?", [
        required(claiming.recurringPaymentId),
      ]);
      await getDb(env).execute("DELETE FROM payment_subscriptions WHERE id = ?", [
        claiming.subscriptionId,
      ]);
    }

    // An update moving another recurring payment onto this wallet holds it as well.
    for (const status of IN_FLIGHT_RECURRING_PAYMENT_ATTEMPT_STATUSES) {
      await getDb(env).execute(
        `INSERT INTO payment_recurring_payment_update_attempts (
           id, organization_id, project_id, recurring_payment_id, mode, status, stage,
           new_source_custody_wallet_id)
         VALUES ('rpua_moving', ?, ?, ?, 'replacement', ?, 'authorize_subscription', ?)`,
        [TEST_ORG.id, tenant.projectId, id, status, tenant.custodyWalletId]
      );
      expect(await list()).toEqual([]);
      await getDb(env).execute(
        "UPDATE payment_recurring_payment_update_attempts SET status = 'confirmed' WHERE id = 'rpua_moving'"
      );
    }
    expect(await list()).toHaveLength(1);
  });

  it("holds one revoke in flight per authority and offers it again only after a later change", async () => {
    const { subscriptionId } = await canceledSchedule();

    const claimed = required(await claim("psar_first"));
    expect(claimed).toMatchObject({ status: "processing", lease_id: "lease_psar_first" });
    expect(await claim("psar_second")).toBeNull();
    expect(await list()).toEqual([]);

    await repo.finish({
      id: claimed.id,
      leaseId: claimed.lease_id,
      status: "confirmed",
      error: null,
      updatedAt: NOW,
    });
    expect(await list()).toEqual([]);

    // Resumed and canceled again after the revoke: the next cancel's period starts over.
    await getDb(env).execute(
      "UPDATE payment_subscriptions SET canceled_at = ?, updated_at = ? WHERE id = ?",
      ["2026-10-21T12:00:01.000Z", "2026-10-21T12:00:01.000Z", subscriptionId]
    );
    expect(await list("2026-10-23T12:00:00.000Z")).toHaveLength(1);
  });

  it("waits out the retry window after a failed revoke", async () => {
    await canceledSchedule();
    const claimed = required(await claim("psar_failed"));
    await repo.finish({
      id: claimed.id,
      leaseId: claimed.lease_id,
      status: "failed",
      error: "refused",
      updatedAt: NOW,
    });

    expect(await list()).toEqual([]);
    expect(await list(NOW, "2026-10-21T12:00:01.000Z")).toHaveLength(1);
  });

  it("refuses an activation, update or resume claim on the wallet while a revoke holds it", async () => {
    await canceledSchedule();
    await canceledSchedule(LONG_AGO, OTHER_AUTHORITY);
    const claimed = required(await claim("psar_guard"));
    const guard = () =>
      getDb(env).transaction((tx) =>
        refuseWhileSubscriptionAuthorityRevokes(tx, {
          projectId: tenant.projectId,
          custodyWalletIds: [tenant.custodyWalletId],
        })
      );

    expect(await repo.hasRevocationHolding({ environment: "sandbox", walletAddress: WALLET })).toBe(
      true
    );
    await expect(guard()).rejects.toMatchObject({ code: "CONFLICT" });
    // Another mint's authority on the wallet can be revoked alongside, and the claim guard waits
    // for both: an activation may not know its mint's authority yet.
    const other = required(await claim("psar_other", OTHER_AUTHORITY));

    for (const revocation of [claimed, other]) {
      await repo.finish({
        id: revocation.id,
        leaseId: revocation.lease_id,
        status: "confirmed",
        error: null,
        updatedAt: NOW,
      });
    }
    await expect(guard()).resolves.toBeUndefined();
  });

  it("lets only the lease holder save, clear or finish a revoke", async () => {
    await canceledSchedule();
    const claimed = required(await claim("psar_lease"));
    const send = {
      id: claimed.id,
      signature: "sig_saved",
      lastValidBlockHeight: "18446744073709551615",
      updatedAt: NOW,
    };

    expect(await repo.saveSend({ ...send, leaseId: "lease_other" })).toBeNull();
    const saved = required(await repo.saveSend({ ...send, leaseId: claimed.lease_id }));
    expect(saved.last_valid_block_height).toBe("18446744073709551615");
    expect(
      await repo.clearSend({ ...send, leaseId: claimed.lease_id, signature: "sig_other" })
    ).toBe(false);

    // A takeover issues a new lease; the run that held the old one can change nothing.
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
    const [takenOver] = await repo.claimStaleRevocations(staleInput);
    expect(takenOver?.lease_id).not.toBe(claimed.lease_id);
    expect(await repo.claimStaleRevocations(staleInput)).toEqual([]);
    expect(await repo.clearSend({ ...send, leaseId: claimed.lease_id })).toBe(false);
    expect(
      await repo.finish({
        id: claimed.id,
        leaseId: claimed.lease_id,
        status: "failed",
        error: "late",
        updatedAt: NOW,
      })
    ).toBeNull();
    expect(await repo.clearSend({ ...send, leaseId: required(takenOver).lease_id })).toBe(true);
  });
});
