// @vitest-environment jsdom

import type { PaymentRequest } from "@sdp/types";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { PaymentRequestsWorkspace } from "./payment-requests-workspace.redesign";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    dashboardCacheScope: { orgId: "org_test", userId: "user_test" },
    selectedProjectId: "proj_test",
    sdpEnvironment: "sandbox",
    flags: {},
  }),
  useOptionalDashboardWorkspace: () => null,
}));

const paymentRequest = {
  id: "preq_1",
  publicToken: "tok_1",
  counterpartyId: null,
  destinationAddress: "11111111111111111111111111111111",
  token: "So11111111111111111111111111111111111111112",
  amount: "5",
  reference: "ref_1",
  status: "awaiting_payment",
  createdAt: "2026-09-14T00:00:00.000Z",
} as PaymentRequest;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

function renderWorkspace(props: Partial<ComponentProps<typeof PaymentRequestsWorkspace>> = {}) {
  return render(
    <PaymentRequestsWorkspace
      initialPaymentRequests={[paymentRequest]}
      counterparties={[]}
      total={1}
      totalIsExact
      hasNextPage={false}
      listState={{ page: 1, pageSize: 25, status: null, search: null }}
      {...props}
    />,
    { wrapper }
  );
}

afterEach(() => {
  cleanup();
  router.replace.mockReset();
  window.history.replaceState(null, "", "/");
});

const otherRequest = {
  ...paymentRequest,
  id: "preq_2",
  publicToken: "tok_2",
  counterpartyId: "cp_jane",
  amount: "80",
  reference: "ref_2",
} as PaymentRequest;

describe("PaymentRequestsWorkspace search", () => {
  it("puts a search in the URL on Enter, from the first page", async () => {
    window.history.replaceState(null, "", "/dashboard/payments/requests?page=3&status=paid");
    renderWorkspace({ listState: { page: 3, pageSize: 25, status: "paid", search: null } });

    await userEvent.type(screen.getByRole("searchbox"), " jane {Enter}");

    expect(router.replace).toHaveBeenCalledWith(
      "/dashboard/payments/requests?status=paid&search=jane",
      { scroll: false }
    );
  });

  it("does not reload for a search the list already shows", async () => {
    renderWorkspace({ listState: { page: 1, pageSize: 25, status: null, search: "jane" } });

    await userEvent.type(screen.getByRole("searchbox"), "{Enter}");

    expect(router.replace).not.toHaveBeenCalled();
  });

  it("shows the page's rows that match the search, by payer, and names the page alone", () => {
    renderWorkspace({
      initialPaymentRequests: [paymentRequest, otherRequest],
      counterparties: [{ id: "cp_jane", displayName: "Jane Doe" } as never],
      total: 2,
      listState: { page: 1, pageSize: 25, status: null, search: "jane" },
    });

    expect(screen.getByText("Jane Doe")).toBeTruthy();
    expect(screen.queryByText("anyone")).toBeNull();
    expect(screen.getByText("Page 1")).toBeTruthy();
    expect(screen.queryByText(/of 2 requests/)).toBeNull();
  });

  it("shows no matches, not the empty directory, when a search finds nothing", () => {
    renderWorkspace({
      initialPaymentRequests: [paymentRequest],
      total: 1,
      listState: { page: 1, pageSize: 25, status: null, search: "nobody" },
    });

    expect(screen.getByText("No requests match these filters.")).toBeTruthy();
    expect(screen.getByRole("searchbox")).toHaveProperty("value", "nobody");
  });
});

describe("PaymentRequestsWorkspace pager", () => {
  it("shows which rows of how many when the total is exact", () => {
    renderWorkspace({ total: 40, hasNextPage: true });

    expect(screen.getByText("1-25 of 40 requests")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next page" })).toHaveProperty("disabled", false);
  });

  it("names the page alone when the total is not exact, and offers the next while there is one", () => {
    renderWorkspace({
      total: 40,
      totalIsExact: false,
      hasNextPage: true,
      listState: { page: 2, pageSize: 25, status: "awaiting_payment", search: null },
    });

    expect(screen.getByText("Page 2")).toBeTruthy();
    expect(screen.queryByText(/of 40 requests/)).toBeNull();
    expect(screen.getByRole("button", { name: "Next page" })).toHaveProperty("disabled", false);
    cleanup();

    renderWorkspace({
      total: 40,
      totalIsExact: false,
      hasNextPage: false,
      listState: { page: 2, pageSize: 25, status: "awaiting_payment", search: null },
    });
    expect(screen.getByRole("button", { name: "Next page" })).toHaveProperty("disabled", true);
  });
});
