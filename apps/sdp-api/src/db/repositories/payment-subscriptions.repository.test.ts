import type {
  PaymentRecurringPaymentStatus,
  PaymentSubscriptionCollectionAttemptStatus,
  PaymentSubscriptionStatus,
} from "@sdp/types/payments";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { TEST_ORG } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { required } from "@/test/helpers/required";
import {
  type SubscriptionAuthorityTenant,
  seedAuthoritySubscription,
  seedRecurringPaymentUpdateAttempt,
  seedSubscriptionAuthorityTenant,
} from "@/test/helpers/subscription-authorities";
import { seedTestDatabase } from "@/test/mocks/db";
import type {
  ListPaymentSubscriptionCollectionAttemptsResult,
  ListRecurringPaymentCollectionAttemptsInput,
  PaymentSubscriptionsRepository,
} from "./payment-subscriptions.repository";
import { createPostgresPaymentSubscriptionsRepository } from "./payment-subscriptions.repository.postgres";

const PROJECT_ID = "prj_collection_history_test";
const MINT = "Mint111111111111111111111111111111111111";
const ALL_ATTEMPTS = ["psca_history_3", "psca_history_2", "psca_history_1"];

describe("PaymentSubscriptionsRepository.listRecurringPaymentCollectionAttempts (postgres)", () => {
  let repo: PaymentSubscriptionsRepository;
  let tenant: SubscriptionAuthorityTenant;
  let recurringPaymentId: string;
  let replacedSubscriptionId: string;
  let currentSubscriptionId: string;

  beforeAll(async () => {
    await seedTestDatabase(env);
  });

  afterAll(async () => {
    await seedTestDatabase(env);
  });

  function seedSchedule(
    status: PaymentSubscriptionStatus,
    recurring: { status: PaymentRecurringPaymentStatus } | null
  ) {
    return seedAuthoritySubscription(tenant, {
      authority: "Authority1111111111111111111111111111111",
      tokenMint: MINT,
      status,
      changedAt: "2026-01-01T00:00:00.000Z",
      recurring,
    });
  }

  async function seedAttempt(input: {
    id: string;
    projectId: string;
    subscriptionId: string;
    status: PaymentSubscriptionCollectionAttemptStatus;
    createdAt: string;
  }) {
    required(
      await repo.createCollectionAttempt({
        ...input,
        organizationId: TEST_ORG.id,
        transferId: null,
        token: MINT,
        amount: "1",
        dueAt: input.createdAt,
        attemptedAt: input.createdAt,
        signature: null,
        error: null,
        metadata: { source: "automated", recurringPaymentId, initiatedByKeyId: null },
        updatedAt: input.createdAt,
      })
    );
  }

  function list(
    page: Omit<
      ListRecurringPaymentCollectionAttemptsInput,
      "organizationId" | "projectId" | "recurringPaymentId"
    >
  ) {
    return repo.listRecurringPaymentCollectionAttempts({
      organizationId: TEST_ORG.id,
      projectId: PROJECT_ID,
      recurringPaymentId,
      ...page,
    });
  }

  function attemptIds(result: ListPaymentSubscriptionCollectionAttemptsResult) {
    return result.rows.map((row) => row.id);
  }

  beforeEach(async () => {
    tenant = await seedSubscriptionAuthorityTenant({
      projectId: PROJECT_ID,
      custodyWalletId: "cwlt_collection_history_test",
      providerWalletId: "wallet_collection_history_test",
      walletAddress: "Sender111111111111111111111111111111111",
    });
    repo = createPostgresPaymentSubscriptionsRepository(getDb(env));
    const replaced = await seedSchedule("canceled", { status: "paused" });
    recurringPaymentId = required(replaced.recurringPaymentId);
    replacedSubscriptionId = replaced.subscriptionId;
    currentSubscriptionId = (await seedSchedule("active", null)).subscriptionId;
    await getDb(env).execute(
      "UPDATE payment_recurring_payments SET subscription_id = ? WHERE id = ?",
      [currentSubscriptionId, recurringPaymentId]
    );
    await seedRecurringPaymentUpdateAttempt(tenant, {
      id: "rpua_history_edit",
      recurringPaymentId,
      status: "confirmed",
      stage: "finalize",
      oldSubscriptionId: replacedSubscriptionId,
      newSubscriptionId: currentSubscriptionId,
    });
    for (const attempt of [
      {
        id: "psca_history_1",
        subscriptionId: replacedSubscriptionId,
        status: "confirmed",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "psca_history_2",
        subscriptionId: replacedSubscriptionId,
        status: "failed",
        createdAt: "2026-01-02T00:00:00.000Z",
      },
      {
        id: "psca_history_3",
        subscriptionId: currentSubscriptionId,
        status: "confirmed",
        createdAt: "2026-01-02T00:00:00.000Z",
      },
    ] as const) {
      await seedAttempt({ ...attempt, projectId: PROJECT_ID });
    }
  });

  it("lists the replaced and the current subscription's attempts newest first, id breaking ties", async () => {
    const result = await list({ limit: 20, offset: 0 });

    expect(result.rows.map((row) => [row.id, row.subscription_id])).toEqual([
      ["psca_history_3", currentSubscriptionId],
      ["psca_history_2", replacedSubscriptionId],
      ["psca_history_1", replacedSubscriptionId],
    ]);
    expect(result.total).toBe(3);
  });

  it("pages the history one row at a time without duplicates or gaps, at a constant total", async () => {
    const pages = await Promise.all([0, 1, 2, 3].map((offset) => list({ limit: 1, offset })));

    expect(pages.map(attemptIds)).toEqual([...ALL_ATTEMPTS.map((id) => [id]), []]);
    expect(pages.map((page) => page.total)).toEqual([3, 3, 3, 3]);
  });

  it("filters the whole history by status and counts only the matching attempts", async () => {
    const result = await list({ status: "confirmed", limit: 1, offset: 1 });

    expect(attemptIds(result)).toEqual(["psca_history_1"]);
    expect(result.total).toBe(2);
  });

  it("excludes another project's attempt on a subscription the payment had", async () => {
    await seedAttempt({
      id: "psca_history_other_project",
      projectId: `${PROJECT_ID}_production`,
      subscriptionId: replacedSubscriptionId,
      status: "confirmed",
      createdAt: "2026-01-03T00:00:00.000Z",
    });

    const result = await list({ limit: 20, offset: 0 });

    expect(attemptIds(result)).toEqual(ALL_ATTEMPTS);
    expect(result.total).toBe(3);
  });

  it("excludes the attempts of a subscription another payment's edit replaced", async () => {
    const sibling = await seedSchedule("canceled", { status: "paused" });
    await seedRecurringPaymentUpdateAttempt(tenant, {
      id: "rpua_history_sibling_edit",
      recurringPaymentId: required(sibling.recurringPaymentId),
      status: "confirmed",
      stage: "finalize",
      oldSubscriptionId: sibling.subscriptionId,
      newSubscriptionId: null,
    });
    await seedAttempt({
      id: "psca_history_sibling",
      projectId: PROJECT_ID,
      subscriptionId: sibling.subscriptionId,
      status: "confirmed",
      createdAt: "2026-01-03T00:00:00.000Z",
    });

    const result = await list({ limit: 20, offset: 0 });

    expect(attemptIds(result)).toEqual(ALL_ATTEMPTS);
    expect(result.total).toBe(3);
  });
});
