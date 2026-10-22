// @vitest-environment jsdom

import type { PaymentRequest } from "@sdp/types/payments";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { PaymentRequestsWorkspace } from "./payment-requests-workspace";

if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/lib/dashboard-url-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dashboard-url-state")>()),
  useDashboardTab: () => "overview",
}));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    dashboardCacheScope: { orgId: "org_test", userId: "user_test" },
    selectedProjectId: "proj_test",
    sdpEnvironment: "sandbox",
    flags: {},
  }),
  useOptionalDashboardWorkspace: () => null,
}));

const requestA: PaymentRequest = {
  id: "preq_a",
  organizationId: "org_test",
  projectId: "proj_test",
  walletId: "wal_1",
  destinationAddress: "11111111111111111111111111111111",
  token: SOL_MINT,
  amount: "5",
  reference: "ref_a",
  status: "awaiting_payment",
  expiresAt: null,
  fulfilledByTransferId: null,
  canceledBy: null,
  lifecycle: [{ status: "awaiting_payment", at: "2026-09-14T00:00:00.000Z" }],
  createdBy: null,
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:00:00.000Z",
};
const requestB: PaymentRequest = { ...requestA, id: "preq_b", amount: "80", reference: "ref_b" };

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

function linkResponse(id: string, publicToken: string): Response {
  return Response.json({ data: { id, publicToken } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PaymentRequestsWorkspace pay link", () => {
  it("never shows a link read for a row the user has since moved off", async () => {
    const pending = new Map<string, (response: Response) => void>();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        (input) =>
          new Promise((resolve) => {
            pending.set(String(input).includes("preq_a") ? "a" : "b", resolve);
          })
      )
    );
    render(
      <PaymentRequestsWorkspace
        initialPaymentRequests={[requestA, requestB]}
        apiBaseUrl={null}
        wallets={[]}
      />,
      { wrapper }
    );
    const user = userEvent.setup();
    const rows = screen.getAllByRole("button", { name: /awaiting/i });
    const rowA = rows.find((row) => row.textContent?.startsWith("Awaiting payment5.00"));
    const rowB = rows.find((row) => row.textContent?.startsWith("Awaiting payment80.00"));
    if (!rowA || !rowB) throw new Error("rows not rendered");

    await user.click(rowA);
    await user.click(rowB);
    await act(async () => pending.get("b")?.(linkResponse("preq_b", "token_b")));
    await act(async () => pending.get("a")?.(linkResponse("preq_a", "token_a")));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/\/pay\/token_b$/)).toBeTruthy();
    expect(within(dialog).queryByText(/token_a/)).toBeNull();
    expect(within(dialog).getAllByText(/80\.00/).length).toBeGreaterThan(0);
  });
});
