import { beforeEach, describe, expect, it, vi } from "vitest";
import RecurringPaymentDetailRoute from "./page";

const harness = vi.hoisted(() => ({
  fetchRecurringPaymentById: vi.fn(),
  request: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: "user_test", orgId: "org_test" }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (href: string) => {
    throw new Error(`NEXT_REDIRECT ${href}`);
  },
}));
vi.mock("@/lib/dashboard-page-trace", () => ({
  withDashboardPageTrace: (_source: string, run: (context: unknown) => Promise<unknown>) =>
    run({
      trace: { step: <T,>(_name: string, step: () => T) => step(), log: () => undefined },
      apiClient: { request: harness.request },
    }),
}));
vi.mock("@/lib/sdp-api", () => ({
  requestProjectHref: async (dashboardPath: string) =>
    dashboardPath.replace("/dashboard", "/dashboard/prj_test"),
}));
vi.mock("@/i18n/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/auth-entry", () => ({ getAuthEntryPath: async () => "/sign-in" }));
vi.mock("@/app/dashboard/[projectId]/payments/recurring/recurring-payments.data", () => ({
  fetchRecurringPaymentById: harness.fetchRecurringPaymentById,
  fetchRecurringPaymentCollectionAttempts: vi.fn(),
}));
vi.mock("@/app/dashboard/[projectId]/payments/payments-page.data", () => ({
  fetchPaymentsWallets: async () => ({ ok: true, data: [] }),
  fetchPaymentsIssuedTokenSymbols: async () => ({ ok: true, data: [] }),
}));
vi.mock("@/app/dashboard/[projectId]/payments/counterparty/counterparty-page.data", () => ({
  fetchCounterparty: vi.fn(),
}));
vi.mock(
  "@/app/dashboard/[projectId]/payments/recurring/recurring-payment-detail-workspace",
  () => ({ RecurringPaymentDetailWorkspace: () => null })
);

function render(recurringPaymentId: string) {
  return RecurringPaymentDetailRoute({ params: Promise.resolve({ recurringPaymentId }) });
}

describe("RecurringPaymentDetailRoute", () => {
  beforeEach(() => {
    harness.fetchRecurringPaymentById.mockReset();
  });

  it("is not found when the API has no such schedule", async () => {
    harness.fetchRecurringPaymentById.mockResolvedValue({
      ok: false,
      status: 404,
      error: "Recurring payment not found",
    });

    await expect(render("rp_unknown")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("goes back to the list for a demo schedule once demo mode is off", async () => {
    harness.fetchRecurringPaymentById.mockResolvedValue({
      ok: false,
      status: 404,
      error: "Recurring payment not found",
    });

    await expect(render("demo_rp_northwind_supply")).rejects.toThrow(
      "NEXT_REDIRECT /dashboard/prj_test/payments/recurring"
    );
  });

  it.each([
    ["a server error", 500],
    ["a failed request", null],
  ])("keeps the error boundary for %s", async (_case, status) => {
    harness.fetchRecurringPaymentById.mockResolvedValue({
      ok: false,
      status,
      error: "Upstream unavailable",
    });

    await expect(render("demo_rp_northwind_supply")).rejects.toThrow("Upstream unavailable");
    await expect(render("rp_unknown")).rejects.toThrow("Upstream unavailable");
  });
});
