import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentRecurringPaymentRow } from "@/db/repositories";
import { AppError } from "@/lib/errors";
import { rootLogger } from "@/runtime/logger";
import { env } from "@/test/helpers/env";

type StaleUpdateRow = PaymentRecurringPaymentRow & {
  oldest_updated_at: string;
  stale_count: number;
};

interface MockState {
  activateRecurringPayment: ReturnType<typeof vi.fn>;
  cancelRecurringPayment: ReturnType<typeof vi.fn>;
  collectRecurringPayment: ReturnType<typeof vi.fn>;
  journalAutomatedCollectionFailure: ReturnType<typeof vi.fn>;
  resumeRecurringPayment: ReturnType<typeof vi.fn>;
  findOperationalWalletById: ReturnType<typeof vi.fn>;
  listStaleLifecyclePayments: ReturnType<typeof vi.fn>;
  listStaleUpdatePayments: ReturnType<typeof vi.fn>;
  listRecoverableCollectionPayments: ReturnType<typeof vi.fn>;
  listDueCollectionPayments: ReturnType<typeof vi.fn>;
  rows: {
    due: PaymentRecurringPaymentRow[];
    lifecycle: PaymentRecurringPaymentRow[];
    staleCollection: PaymentRecurringPaymentRow[];
    staleUpdate: StaleUpdateRow[];
  };
}

const mocks = vi.hoisted<MockState>(() => ({
  activateRecurringPayment: vi.fn(),
  cancelRecurringPayment: vi.fn(),
  collectRecurringPayment: vi.fn(),
  journalAutomatedCollectionFailure: vi.fn(),
  resumeRecurringPayment: vi.fn(),
  findOperationalWalletById: vi.fn(),
  listStaleLifecyclePayments: vi.fn(),
  listStaleUpdatePayments: vi.fn(),
  listRecoverableCollectionPayments: vi.fn(),
  listDueCollectionPayments: vi.fn(),
  rows: {
    due: [],
    lifecycle: [],
    staleCollection: [],
    staleUpdate: [],
  },
}));

vi.mock("@/db", () => ({
  getDb: () => ({}),
}));

vi.mock("@/db/repositories/payment-recurring-payments.repository.postgres", () => ({
  createPostgresPaymentRecurringPaymentsRepository: () => ({
    listStaleLifecyclePayments: mocks.listStaleLifecyclePayments,
    listStaleUpdatePayments: mocks.listStaleUpdatePayments,
    listRecoverableCollectionPayments: mocks.listRecoverableCollectionPayments,
    listDueCollectionPayments: mocks.listDueCollectionPayments,
  }),
}));

vi.mock("@/services/domain/signing/custody-runtime-target", () => ({
  CustodyRuntimeTargets: class {
    findOperationalWalletById = mocks.findOperationalWalletById;
  },
}));

vi.mock("@/services/payments/recurring-payments", () => ({
  activateRecurringPayment: mocks.activateRecurringPayment,
  cancelRecurringPayment: mocks.cancelRecurringPayment,
  collectRecurringPayment: mocks.collectRecurringPayment,
  journalAutomatedCollectionFailure: mocks.journalAutomatedCollectionFailure,
  resumeRecurringPayment: mocks.resumeRecurringPayment,
}));

let collectDueRecurringPayments: typeof import("./collect-recurring-payments").collectDueRecurringPayments;
let activateRecurringPayment: typeof import("@/services/payments/recurring-payments").activateRecurringPayment;
let cancelRecurringPayment: typeof import("@/services/payments/recurring-payments").cancelRecurringPayment;
let collectRecurringPayment: typeof import("@/services/payments/recurring-payments").collectRecurringPayment;
let resumeRecurringPayment: typeof import("@/services/payments/recurring-payments").resumeRecurringPayment;

function recurringRow(
  status: PaymentRecurringPaymentRow["status"],
  overrides: Partial<PaymentRecurringPaymentRow> = {}
): PaymentRecurringPaymentRow {
  return {
    id: `prp_${status}`,
    organization_id: "org_1",
    project_id: "proj_1",
    source_custody_wallet_id: "cwlt_1",
    source_wallet_id: "wallet_1",
    source_address: "source_address",
    counterparty_id: "cpty_1",
    counterparty_account_id: "counterparty_account_1",
    destination_address: "destination_address",
    destination_token_account: null,
    token: "token_mint",
    amount: "10",
    period_hours: 24,
    first_collection_at: null,
    next_collection_due_at: "2026-07-01T12:00:00.000Z",
    plan_id: "plan_1",
    subscription_id: "sub_1",
    plan_pda: "plan_pda",
    plan_created_at: "2026-07-01T11:00:00.000Z",
    plan_creation_signature: "plan_sig",
    subscription_pda: "sub_pda",
    subscription_authority_address: "sub_auth",
    authorization_signature: "auth_sig",
    status,
    metadata_uri: null,
    created_by: null,
    created_at: "2026-07-01T11:00:00.000Z",
    updated_at: "2026-07-01T11:00:00.000Z",
    ...overrides,
  };
}

describe("collectDueRecurringPayments", () => {
  beforeAll(async () => {
    ({ collectDueRecurringPayments } = await import("./collect-recurring-payments"));
    ({
      activateRecurringPayment,
      cancelRecurringPayment,
      collectRecurringPayment,
      resumeRecurringPayment,
    } = await import("@/services/payments/recurring-payments"));
  });

  beforeEach(() => {
    mocks.activateRecurringPayment.mockReset();
    mocks.cancelRecurringPayment.mockReset();
    mocks.collectRecurringPayment.mockReset();
    mocks.journalAutomatedCollectionFailure.mockReset();
    mocks.resumeRecurringPayment.mockReset();
    mocks.findOperationalWalletById.mockReset();
    mocks.rows.due = [];
    mocks.rows.lifecycle = [];
    mocks.rows.staleCollection = [];
    mocks.rows.staleUpdate = [];
    mocks.listStaleLifecyclePayments.mockImplementation(async () => mocks.rows.lifecycle);
    mocks.listStaleUpdatePayments.mockImplementation(async () => mocks.rows.staleUpdate);
    mocks.listRecoverableCollectionPayments.mockImplementation(
      async () => mocks.rows.staleCollection
    );
    mocks.listDueCollectionPayments.mockImplementation(async () => mocks.rows.due);
    mocks.findOperationalWalletById.mockResolvedValue({
      id: "cwlt_1",
      walletId: "wallet_1",
      publicKey: "source_address",
    });
    mocks.activateRecurringPayment.mockResolvedValue(recurringRow("active"));
    mocks.cancelRecurringPayment.mockResolvedValue(recurringRow("canceled"));
    mocks.collectRecurringPayment.mockResolvedValue({});
    mocks.resumeRecurringPayment.mockResolvedValue(recurringRow("active"));
  });

  it("recovers interrupted operations before collecting due payments", async () => {
    const lifecycle = recurringRow("activating", { id: "prp_activation" });
    const staleCollection = recurringRow("active", { id: "prp_stale_collection" });
    const due = recurringRow("active", { id: "prp_due" });
    mocks.rows.lifecycle = [lifecycle];
    mocks.rows.staleCollection = [staleCollection];
    mocks.rows.due = [due];

    const result = await collectDueRecurringPayments(env, new Date("2026-07-01T12:30:00Z"));

    expect(result).toEqual({ recovered: 2, collected: 1, failed: 0, skipped: 0 });
    expect(activateRecurringPayment).toHaveBeenCalledWith(
      expect.objectContaining({ recurringPayment: lifecycle })
    );
    expect(collectRecurringPayment).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        recurringPayment: staleCollection,
        initiatedByKeyId: null,
        collectionSource: "automated",
      })
    );
    expect(collectRecurringPayment).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        recurringPayment: due,
        initiatedByKeyId: null,
        collectionSource: "automated",
      })
    );
  });

  it("routes canceling and resuming rows through lifecycle recovery", async () => {
    const canceling = recurringRow("canceling", { id: "prp_canceling" });
    const resuming = recurringRow("resuming", { id: "prp_resuming" });
    mocks.rows.lifecycle = [canceling, resuming];

    const result = await collectDueRecurringPayments(env, new Date());

    expect(result).toEqual({ recovered: 2, collected: 0, failed: 0, skipped: 0 });
    expect(cancelRecurringPayment).toHaveBeenCalledWith(
      expect.objectContaining({ recurringPayment: canceling })
    );
    expect(resumeRecurringPayment).toHaveBeenCalledWith(
      expect.objectContaining({ recurringPayment: resuming })
    );
  });

  it("recovers a canceled payment attempt without creating a future collection", async () => {
    const canceled = recurringRow("canceled");
    mocks.rows.staleCollection = [canceled];

    const result = await collectDueRecurringPayments(env, new Date());

    expect(result).toEqual({ recovered: 1, collected: 0, failed: 0, skipped: 0 });
    expect(collectRecurringPayment).toHaveBeenCalledWith(
      expect.objectContaining({ recurringPayment: canceled })
    );
    expect(collectRecurringPayment).toHaveBeenCalledTimes(1);
  });

  it("uses product batch-size and retry-after controls", async () => {
    await collectDueRecurringPayments(env, new Date("2026-07-01T12:30:00Z"));

    expect(mocks.listDueCollectionPayments).toHaveBeenCalledWith({
      dueBefore: "2026-07-01T12:30:00.000Z",
      retryBefore: "2026-07-01T12:00:00.000Z",
      limit: 25,
    });
  });

  it("treats collection conflicts as duplicate-prevention skips", async () => {
    mocks.rows.due = [recurringRow("active")];
    mocks.collectRecurringPayment.mockRejectedValue(new AppError("CONFLICT", "Already claimed"));

    const result = await collectDueRecurringPayments(env, new Date());

    expect(result).toEqual({ recovered: 0, collected: 0, failed: 0, skipped: 1 });
  });

  it("fails closed when a recurring payment has no exact source wallet", async () => {
    const warn = vi.spyOn(rootLogger, "warn").mockImplementation(() => undefined);
    mocks.rows.due = [recurringRow("active", { source_custody_wallet_id: null })];

    const result = await collectDueRecurringPayments(env, new Date());

    expect(result).toEqual({ recovered: 0, collected: 0, failed: 1, skipped: 0 });
    expect(collectRecurringPayment).not.toHaveBeenCalled();
    expect(mocks.journalAutomatedCollectionFailure).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      {
        organization_id: "org_1",
        project_id: "proj_1",
        recurring_payment_id: "prp_active",
        reason: "unresolved_source_wallet",
      },
      "collectDueRecurringPayments: recurring payment has no exact source wallet"
    );
    warn.mockRestore();
  });

  it.each([
    ["provider wallet ID", { id: "cwlt_1", walletId: "wallet_other", publicKey: "source_address" }],
    ["public key", { id: "cwlt_1", walletId: "wallet_1", publicKey: "other_address" }],
  ])("fails closed when the exact source wallet %s does not match its pin", async (_, wallet) => {
    const warn = vi.spyOn(rootLogger, "warn").mockImplementation(() => undefined);
    mocks.rows.due = [recurringRow("active")];
    mocks.findOperationalWalletById.mockResolvedValue(wallet);

    const result = await collectDueRecurringPayments(env, new Date());

    expect(result).toEqual({ recovered: 0, collected: 0, failed: 1, skipped: 0 });
    expect(mocks.findOperationalWalletById).toHaveBeenCalledWith({
      organizationId: "org_1",
      projectId: "proj_1",
      custodyWalletId: "cwlt_1",
    });
    expect(collectRecurringPayment).not.toHaveBeenCalled();
    expect(mocks.journalAutomatedCollectionFailure).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      {
        organization_id: "org_1",
        project_id: "proj_1",
        recurring_payment_id: "prp_active",
        custody_wallet_id: "cwlt_1",
        reason: "source_wallet_mismatch",
      },
      "collectDueRecurringPayments: recurring payment source wallet does not match its pin"
    );
    warn.mockRestore();
  });

  it("summarizes stale recurring payment updates without changing them", async () => {
    const warn = vi.spyOn(rootLogger, "warn").mockImplementation(() => undefined);
    mocks.rows.staleUpdate = [
      {
        ...recurringRow("updating", {
          id: "prp_newer_update",
          updated_at: "2026-07-01T11:05:00.000Z",
        }),
        oldest_updated_at: "2026-07-01T11:00:00.000Z",
        stale_count: 27,
      },
      {
        ...recurringRow("updating", { id: "prp_older_update" }),
        oldest_updated_at: "2026-07-01T11:00:00.000Z",
        stale_count: 27,
      },
    ];

    const result = await collectDueRecurringPayments(env, new Date("2026-07-01T12:30:00Z"));

    expect(result).toEqual({ recovered: 0, collected: 0, failed: 0, skipped: 0 });
    expect(collectRecurringPayment).not.toHaveBeenCalled();
    expect(mocks.journalAutomatedCollectionFailure).not.toHaveBeenCalled();
    expect(mocks.listStaleUpdatePayments).toHaveBeenCalledWith({
      staleBefore: "2026-07-01T12:15:00.000Z",
      limit: 25,
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      {
        oldest_updated_at: "2026-07-01T11:00:00.000Z",
        reason: "stale_recurring_payment_updates",
        recurring_payments: [
          {
            organization_id: "org_1",
            project_id: "proj_1",
            recurring_payment_id: "prp_newer_update",
            updated_at: "2026-07-01T11:05:00.000Z",
          },
          {
            organization_id: "org_1",
            project_id: "proj_1",
            recurring_payment_id: "prp_older_update",
            updated_at: "2026-07-01T11:00:00.000Z",
          },
        ],
        stale_count: 27,
        truncated: true,
      },
      "collectDueRecurringPayments: recurring payment updates are stale; collections stay paused until callers retry the same updates"
    );
    warn.mockRestore();
  });
});
