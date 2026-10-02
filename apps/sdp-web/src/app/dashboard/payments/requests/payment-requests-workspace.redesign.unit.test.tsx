// @vitest-environment jsdom

import type { PaymentRequest } from "@sdp/types";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { PAYMENT_REQUESTS_SCAN_CAP } from "./payment-requests-page.data";
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
      searchCapped={false}
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

describe("PaymentRequestsWorkspace search", () => {
  it("keeps the search box disabled until the API can search", async () => {
    renderWorkspace();

    const searchbox = screen.getByRole("searchbox");
    expect(searchbox).toHaveProperty("disabled", true);
    await userEvent.type(searchbox, "jane{Enter}");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("says when the search stopped at the cap", () => {
    renderWorkspace({
      searchCapped: true,
      listState: { page: 1, pageSize: 25, status: null, search: "jane" },
    });

    expect(
      screen.getByText(`Search covers the newest ${PAYMENT_REQUESTS_SCAN_CAP} requests only.`)
    ).toBeTruthy();
  });

  it("shows no matches, not the empty directory, when a search finds nothing", () => {
    renderWorkspace({
      initialPaymentRequests: [],
      total: 0,
      listState: { page: 1, pageSize: 25, status: null, search: "nobody" },
    });

    expect(screen.getByText("No requests match these filters.")).toBeTruthy();
    expect(screen.getByRole("searchbox")).toHaveProperty("value", "nobody");
  });
});
