import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPaymentRecurringPaymentsRepository,
  createPaymentSubscriptionsRepository,
} from "@/db/repositories";
import type { PaymentRecurringPaymentRow } from "@/db/repositories/payment-recurring-payments.repository";
import {
  activateRecurringPayment,
  collectRecurringPayment,
  executeRecurringPaymentLifecycle,
} from "@/services/payments/recurring-payments";
import type { Env } from "@/types/env";
import { collectDueRecurringPayments } from "./collect-recurring-payments";

vi.mock("@/db/repositories", () => ({
  createPaymentRecurringPaymentsRepository: vi.fn(),
  createPaymentSubscriptionsRepository: vi.fn(),
}));

vi.mock("@/services/payments/recurring-payments", () => ({
  activateRecurringPayment: vi.fn(),
  collectRecurringPayment: vi.fn(),
  executeRecurringPaymentLifecycle: vi.fn(),
}));

const enabledEnv = {
  PAYMENTS_RECURRING_ENABLED: "true",
  PAYMENTS_RECURRING_COLLECTION_ENABLED: "true",
} as Env;

function makeRecurringPayment(
  overrides: Partial<PaymentRecurringPaymentRow> = {}
): PaymentRecurringPaymentRow {
  const now = new Date().toISOString();

  return {
    id: "prp_test",
    organization_id: "org_test",
    project_id: "prj_test",
    source_wallet_id: "wal_test",
    source_address: "source_address_test",
    counterparty_id: "cp_test",
    counterparty_account_id: "cpa_test",
    destination_address: "destination_address_test",
    destination_token_account: null,
    token: "token_test",
    amount: "1.00",
    period_hours: 24,
    first_collection_at: null,
    next_collection_due_at: now,
    plan_id: "psp_test",
    subscription_id: "psub_test",
    plan_pda: "plan_pda_test",
    plan_created_at: "1",
    plan_creation_signature: "sig_plan_test",
    subscription_pda: "subscription_pda_test",
    subscription_authority_address: "subscription_authority_test",
    authorization_signature: "sig_authorization_test",
    status: "active",
    metadata_uri: null,
    created_by: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe("collectDueRecurringPayments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("continues collecting due payments when stale attempt expiration fails", async () => {
    const duePayment = makeRecurringPayment();
    const expireStaleUnsignedProcessingAttempts = vi
      .fn()
      .mockRejectedValue(new Error("temporary database outage"));
    const listSubmittedRecurringCollectionAttempts = vi.fn().mockResolvedValue([]);
    const listStaleActivationClaims = vi.fn().mockResolvedValue([]);
    const listStaleLifecycleClaims = vi.fn().mockResolvedValue([]);
    const listDueRecurringPayments = vi.fn().mockResolvedValue([duePayment]);
    vi.mocked(createPaymentSubscriptionsRepository).mockReturnValue({
      expireStaleUnsignedProcessingAttempts,
      listSubmittedRecurringCollectionAttempts,
    } as unknown as ReturnType<typeof createPaymentSubscriptionsRepository>);
    vi.mocked(createPaymentRecurringPaymentsRepository).mockReturnValue({
      listStaleActivationClaims,
      listStaleLifecycleClaims,
      listDueRecurringPayments,
    } as unknown as ReturnType<typeof createPaymentRecurringPaymentsRepository>);
    vi.mocked(collectRecurringPayment).mockResolvedValue(
      {} as Awaited<ReturnType<typeof collectRecurringPayment>>
    );

    const result = await collectDueRecurringPayments(enabledEnv);

    expect(result).toEqual({
      scanned: 1,
      collected: 1,
      failed: 1,
      expirationFailures: 1,
      activationRecovered: 0,
      activationFailures: 0,
      lifecycleRecovered: 0,
      lifecycleFailures: 0,
      submittedCollectionRecovered: 0,
      submittedCollectionFailures: 0,
      collectionFailures: 0,
    });
    expect(listStaleActivationClaims).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 20,
      })
    );
    expect(listStaleLifecycleClaims).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 20,
      })
    );
    expect(listDueRecurringPayments).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 20,
      })
    );
    expect(collectRecurringPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        env: enabledEnv,
        organizationId: duePayment.organization_id,
        projectId: duePayment.project_id,
        recurringPaymentId: duePayment.id,
        initiatedByKeyId: null,
        enforceDue: true,
      })
    );
  });

  it("recovers stale activation claims before lifecycle and due collection", async () => {
    const recoveredActivation = makeRecurringPayment({
      id: "prp_activation_recovered",
      status: "activating",
    });
    const failedActivation = makeRecurringPayment({
      id: "prp_activation_failed",
      status: "activating",
    });
    const expireStaleUnsignedProcessingAttempts = vi.fn().mockResolvedValue(0);
    const listSubmittedRecurringCollectionAttempts = vi.fn().mockResolvedValue([]);
    const listStaleActivationClaims = vi
      .fn()
      .mockResolvedValue([recoveredActivation, failedActivation]);
    const listStaleLifecycleClaims = vi.fn().mockResolvedValue([]);
    const listDueRecurringPayments = vi.fn().mockResolvedValue([]);
    const updateRecurringPayment = vi.fn().mockResolvedValue(failedActivation);
    vi.mocked(createPaymentSubscriptionsRepository).mockReturnValue({
      expireStaleUnsignedProcessingAttempts,
      listSubmittedRecurringCollectionAttempts,
    } as unknown as ReturnType<typeof createPaymentSubscriptionsRepository>);
    vi.mocked(createPaymentRecurringPaymentsRepository).mockReturnValue({
      listStaleActivationClaims,
      listStaleLifecycleClaims,
      listDueRecurringPayments,
      updateRecurringPayment,
    } as unknown as ReturnType<typeof createPaymentRecurringPaymentsRepository>);
    vi.mocked(activateRecurringPayment)
      .mockResolvedValueOnce({ recurringPayment: recoveredActivation })
      .mockRejectedValueOnce(new Error("temporary signer outage"));

    const result = await collectDueRecurringPayments(enabledEnv);

    expect(result).toEqual({
      scanned: 0,
      collected: 0,
      failed: 1,
      expirationFailures: 0,
      activationRecovered: 1,
      activationFailures: 1,
      lifecycleRecovered: 0,
      lifecycleFailures: 0,
      submittedCollectionRecovered: 0,
      submittedCollectionFailures: 0,
      collectionFailures: 0,
    });
    expect(activateRecurringPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        env: enabledEnv,
        organizationId: recoveredActivation.organization_id,
        projectId: recoveredActivation.project_id,
        recurringPaymentId: recoveredActivation.id,
      })
    );
    expect(activateRecurringPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        env: enabledEnv,
        organizationId: failedActivation.organization_id,
        projectId: failedActivation.project_id,
        recurringPaymentId: failedActivation.id,
      })
    );
    expect(updateRecurringPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        recurringPaymentId: failedActivation.id,
        organizationId: failedActivation.organization_id,
        projectId: failedActivation.project_id,
        expectedStatus: "activating",
        updatedAt: expect.any(String),
      })
    );
    expect(listStaleLifecycleClaims).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 18,
      })
    );
    expect(listSubmittedRecurringCollectionAttempts).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 18,
      })
    );
    expect(listDueRecurringPayments).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 18,
      })
    );
  });

  it("recovers stale recurring lifecycle claims before due collection", async () => {
    const cancelingPayment = makeRecurringPayment({
      id: "prp_canceling",
      status: "canceling",
    });
    const resumingPayment = makeRecurringPayment({
      id: "prp_resuming",
      status: "resuming",
    });
    const expireStaleUnsignedProcessingAttempts = vi.fn().mockResolvedValue(0);
    const listSubmittedRecurringCollectionAttempts = vi.fn().mockResolvedValue([]);
    const listStaleActivationClaims = vi.fn().mockResolvedValue([]);
    const listStaleLifecycleClaims = vi.fn().mockResolvedValue([cancelingPayment, resumingPayment]);
    const listDueRecurringPayments = vi.fn().mockResolvedValue([]);
    vi.mocked(createPaymentSubscriptionsRepository).mockReturnValue({
      expireStaleUnsignedProcessingAttempts,
      listSubmittedRecurringCollectionAttempts,
    } as unknown as ReturnType<typeof createPaymentSubscriptionsRepository>);
    vi.mocked(createPaymentRecurringPaymentsRepository).mockReturnValue({
      listStaleActivationClaims,
      listStaleLifecycleClaims,
      listDueRecurringPayments,
    } as unknown as ReturnType<typeof createPaymentRecurringPaymentsRepository>);
    vi.mocked(executeRecurringPaymentLifecycle).mockResolvedValue(
      {} as Awaited<ReturnType<typeof executeRecurringPaymentLifecycle>>
    );

    const result = await collectDueRecurringPayments(enabledEnv);

    expect(result).toEqual({
      scanned: 0,
      collected: 0,
      failed: 0,
      expirationFailures: 0,
      activationRecovered: 0,
      activationFailures: 0,
      lifecycleRecovered: 2,
      lifecycleFailures: 0,
      submittedCollectionRecovered: 0,
      submittedCollectionFailures: 0,
      collectionFailures: 0,
    });
    expect(executeRecurringPaymentLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        env: enabledEnv,
        organizationId: cancelingPayment.organization_id,
        projectId: cancelingPayment.project_id,
        recurringPaymentId: cancelingPayment.id,
        operation: "cancel",
      })
    );
    expect(executeRecurringPaymentLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        env: enabledEnv,
        organizationId: resumingPayment.organization_id,
        projectId: resumingPayment.project_id,
        recurringPaymentId: resumingPayment.id,
        operation: "resume",
      })
    );
  });

  it("does not exceed the collection batch budget across recovery and due phases", async () => {
    const cancelingPayment = makeRecurringPayment({
      id: "prp_canceling_budget",
      status: "canceling",
    });
    const resumingPayment = makeRecurringPayment({
      id: "prp_resuming_budget",
      status: "resuming",
    });
    const budgetedEnv = {
      ...enabledEnv,
      PAYMENTS_RECURRING_COLLECTION_BATCH_SIZE: "2",
    } as Env;
    const expireStaleUnsignedProcessingAttempts = vi.fn().mockResolvedValue(0);
    const listSubmittedRecurringCollectionAttempts = vi.fn().mockResolvedValue([]);
    const listStaleActivationClaims = vi.fn().mockResolvedValue([]);
    const listStaleLifecycleClaims = vi.fn().mockResolvedValue([cancelingPayment, resumingPayment]);
    const listDueRecurringPayments = vi.fn().mockResolvedValue([makeRecurringPayment()]);
    vi.mocked(createPaymentSubscriptionsRepository).mockReturnValue({
      expireStaleUnsignedProcessingAttempts,
      listSubmittedRecurringCollectionAttempts,
    } as unknown as ReturnType<typeof createPaymentSubscriptionsRepository>);
    vi.mocked(createPaymentRecurringPaymentsRepository).mockReturnValue({
      listStaleActivationClaims,
      listStaleLifecycleClaims,
      listDueRecurringPayments,
    } as unknown as ReturnType<typeof createPaymentRecurringPaymentsRepository>);
    vi.mocked(executeRecurringPaymentLifecycle).mockResolvedValue(
      {} as Awaited<ReturnType<typeof executeRecurringPaymentLifecycle>>
    );

    const result = await collectDueRecurringPayments(budgetedEnv);

    expect(result).toEqual({
      scanned: 0,
      collected: 0,
      failed: 0,
      expirationFailures: 0,
      activationRecovered: 0,
      activationFailures: 0,
      lifecycleRecovered: 2,
      lifecycleFailures: 0,
      submittedCollectionRecovered: 0,
      submittedCollectionFailures: 0,
      collectionFailures: 0,
    });
    expect(listStaleLifecycleClaims).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 2,
      })
    );
    expect(listStaleActivationClaims).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 2,
      })
    );
    expect(listSubmittedRecurringCollectionAttempts).not.toHaveBeenCalled();
    expect(listDueRecurringPayments).not.toHaveBeenCalled();
    expect(executeRecurringPaymentLifecycle).toHaveBeenCalledTimes(2);
    expect(collectRecurringPayment).not.toHaveBeenCalled();
  });

  it("records a collection failure when listing due recurring payments fails", async () => {
    const expireStaleUnsignedProcessingAttempts = vi.fn().mockResolvedValue(0);
    const listSubmittedRecurringCollectionAttempts = vi.fn().mockResolvedValue([]);
    const listStaleActivationClaims = vi.fn().mockResolvedValue([]);
    const listStaleLifecycleClaims = vi.fn().mockResolvedValue([]);
    const listDueRecurringPayments = vi
      .fn()
      .mockRejectedValue(new Error("temporary due-list outage"));
    vi.mocked(createPaymentSubscriptionsRepository).mockReturnValue({
      expireStaleUnsignedProcessingAttempts,
      listSubmittedRecurringCollectionAttempts,
    } as unknown as ReturnType<typeof createPaymentSubscriptionsRepository>);
    vi.mocked(createPaymentRecurringPaymentsRepository).mockReturnValue({
      listStaleActivationClaims,
      listStaleLifecycleClaims,
      listDueRecurringPayments,
    } as unknown as ReturnType<typeof createPaymentRecurringPaymentsRepository>);

    const result = await collectDueRecurringPayments(enabledEnv);

    expect(result).toEqual({
      scanned: 0,
      collected: 0,
      failed: 1,
      expirationFailures: 0,
      activationRecovered: 0,
      activationFailures: 0,
      lifecycleRecovered: 0,
      lifecycleFailures: 0,
      submittedCollectionRecovered: 0,
      submittedCollectionFailures: 0,
      collectionFailures: 1,
    });
    expect(collectRecurringPayment).not.toHaveBeenCalled();
  });

  it("recovers submitted recurring collections even when they are not due-active", async () => {
    const submittedAttempt = {
      id: "psca_submitted_recovery",
      organization_id: "org_test",
      project_id: "prj_test",
      subscription_id: "psub_test",
      recurring_payment_id: "prp_submitted_recovery",
      transfer_id: "xfr_submitted_recovery",
      token: "token_test",
      amount: "1.00",
      due_at: new Date().toISOString(),
      attempted_at: new Date().toISOString(),
      status: "processing",
      signature: "sig_test",
      error: null,
      metadata: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const expireStaleUnsignedProcessingAttempts = vi.fn().mockResolvedValue(0);
    const listSubmittedRecurringCollectionAttempts = vi.fn().mockResolvedValue([submittedAttempt]);
    const listStaleActivationClaims = vi.fn().mockResolvedValue([]);
    const listStaleLifecycleClaims = vi.fn().mockResolvedValue([]);
    const listDueRecurringPayments = vi.fn().mockResolvedValue([]);
    vi.mocked(createPaymentSubscriptionsRepository).mockReturnValue({
      expireStaleUnsignedProcessingAttempts,
      listSubmittedRecurringCollectionAttempts,
    } as unknown as ReturnType<typeof createPaymentSubscriptionsRepository>);
    vi.mocked(createPaymentRecurringPaymentsRepository).mockReturnValue({
      listStaleActivationClaims,
      listStaleLifecycleClaims,
      listDueRecurringPayments,
    } as unknown as ReturnType<typeof createPaymentRecurringPaymentsRepository>);
    vi.mocked(collectRecurringPayment).mockResolvedValue(
      {} as Awaited<ReturnType<typeof collectRecurringPayment>>
    );

    const result = await collectDueRecurringPayments(enabledEnv);

    expect(result).toEqual({
      scanned: 0,
      collected: 0,
      failed: 0,
      expirationFailures: 0,
      activationRecovered: 0,
      activationFailures: 0,
      lifecycleRecovered: 0,
      lifecycleFailures: 0,
      submittedCollectionRecovered: 1,
      submittedCollectionFailures: 0,
      collectionFailures: 0,
    });
    expect(collectRecurringPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        env: enabledEnv,
        organizationId: submittedAttempt.organization_id,
        projectId: submittedAttempt.project_id,
        recurringPaymentId: submittedAttempt.recurring_payment_id,
        initiatedByKeyId: null,
        enforceDue: false,
      })
    );
  });
});
