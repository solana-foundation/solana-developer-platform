import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentRecurringPaymentRow } from "@/db/repositories";
import { AppError } from "@/lib/errors";
import type { Env } from "@/types/env";

const mocks = vi.hoisted(() => ({
  activateRecurringPayment: vi.fn(),
  cancelRecurringPayment: vi.fn(),
  collectRecurringPayment: vi.fn(),
  resumeRecurringPayment: vi.fn(),
  getWalletById: vi.fn(),
  queryCalls: [] as Array<{ query: string; bindings: Array<string | number> }>,
  rows: {
    due: [] as PaymentRecurringPaymentRow[],
    lifecycle: [] as PaymentRecurringPaymentRow[],
    staleCollection: [] as PaymentRecurringPaymentRow[],
  },
}));

vi.mock("@/db", () => ({
  getDb: () => ({
    prepare: (query: string) => ({
      bind: (...bindings: Array<string | number>) => ({
        all: () => {
          mocks.queryCalls.push({ query, bindings });
          if (query.includes("status IN ('activating', 'canceling', 'resuming')")) {
            return Promise.resolve({ rows: mocks.rows.lifecycle });
          }
          if (query.includes("JOIN payment_subscription_collection_attempts")) {
            return Promise.resolve({ rows: mocks.rows.staleCollection });
          }
          return Promise.resolve({ rows: mocks.rows.due });
        },
      }),
    }),
  }),
}));

vi.mock("@/services/domain/signing.service", () => ({
  createSigningService: () => ({
    getWalletById: mocks.getWalletById,
  }),
}));

vi.mock("@/services/payments/recurring-payments", () => ({
  activateRecurringPayment: mocks.activateRecurringPayment,
  cancelRecurringPayment: mocks.cancelRecurringPayment,
  collectRecurringPayment: mocks.collectRecurringPayment,
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
    source_wallet_id: "wallet_1",
    source_address: "source_address",
    counterparty_id: "counterparty_1",
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
    mocks.resumeRecurringPayment.mockReset();
    mocks.getWalletById.mockReset();
    mocks.queryCalls.length = 0;
    mocks.rows.due = [];
    mocks.rows.lifecycle = [];
    mocks.rows.staleCollection = [];
    mocks.getWalletById.mockResolvedValue({
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

    const result = await collectDueRecurringPayments({} as Env, new Date("2026-07-01T12:30:00Z"));

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

    const result = await collectDueRecurringPayments({} as Env);

    expect(result).toEqual({ recovered: 2, collected: 0, failed: 0, skipped: 0 });
    expect(cancelRecurringPayment).toHaveBeenCalledWith(
      expect.objectContaining({ recurringPayment: canceling })
    );
    expect(resumeRecurringPayment).toHaveBeenCalledWith(
      expect.objectContaining({ recurringPayment: resuming })
    );
  });

  it("uses batch-size and retry-after controls while excluding active attempts", async () => {
    await collectDueRecurringPayments(
      {
        PAYMENTS_RECURRING_COLLECTION_BATCH_SIZE: "7",
        PAYMENTS_RECURRING_COLLECTION_RETRY_AFTER_MINUTES: "45",
      } as Env,
      new Date("2026-07-01T12:30:00Z")
    );

    const dueQuery = mocks.queryCalls.find((call) =>
      call.query.includes("failed_attempt.updated_at > ?")
    );
    expect(dueQuery?.bindings).toEqual(["2026-07-01T12:30:00.000Z", "2026-07-01T11:45:00.000Z", 7]);
    expect(dueQuery?.query).toContain(
      "active_attempt.status IN ('pending', 'processing', 'confirmed')"
    );
    const staleCollectionQuery = mocks.queryCalls.find((call) =>
      call.query.includes("JOIN payment_subscription_collection_attempts")
    );
    expect(staleCollectionQuery?.query).toContain("ROW_NUMBER() OVER");
    expect(staleCollectionQuery?.query).toContain("PARTITION BY rp.id");
  });

  it("treats collection conflicts as duplicate-prevention skips", async () => {
    mocks.rows.due = [recurringRow("active")];
    mocks.collectRecurringPayment.mockRejectedValue(new AppError("CONFLICT", "Already claimed"));

    const result = await collectDueRecurringPayments({} as Env);

    expect(result).toEqual({ recovered: 0, collected: 0, failed: 0, skipped: 1 });
  });
});
