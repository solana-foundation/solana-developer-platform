// @vitest-environment jsdom

import type { PaymentRequest } from "@sdp/types";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { PaymentRequestsWorkspace } from "./payment-requests-workspace";

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/lib/dashboard-fetch", () => ({ dashboardFetch: vi.fn() }));
vi.mock("@/lib/dashboard-url-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dashboard-url-state")>()),
  useDashboardTab: () => "overview",
}));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    dashboardCacheScope: { orgId: "org_test", userId: "user_test" },
    selectedProjectId: "proj_test",
    sdpEnvironment: "sandbox",
    selectedPlaygroundApiKeyId: null,
    setPlaygroundApiKeys: () => {},
    flags: {},
  }),
  useOptionalDashboardWorkspace: () => null,
}));

const requestA = {
  id: "preq_a",
  counterpartyId: null,
  walletId: "wal_1",
  destinationAddress: "11111111111111111111111111111111",
  token: "So11111111111111111111111111111111111111112",
  amount: "5",
  reference: "ref_a",
  status: "awaiting_payment",
  expiresAt: null,
  createdAt: "2026-09-14T00:00:00.000Z",
} as PaymentRequest;
const requestB = { ...requestA, id: "preq_b", amount: "80", reference: "ref_b" } as PaymentRequest;

type LinkResponse = Awaited<ReturnType<typeof dashboardFetch>>;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

function linkResponse(publicToken: string): LinkResponse {
  // SAFETY: the workspace reads only ok and data.data.publicToken.
  return { ok: true, data: { data: { publicToken } } } as unknown as LinkResponse;
}

afterEach(() => {
  cleanup();
  vi.mocked(dashboardFetch).mockReset();
});

describe("PaymentRequestsWorkspace pay link", () => {
  it("never shows a link read for a row the user has since moved off", async () => {
    const pending = new Map<string, (response: LinkResponse) => void>();
    vi.mocked(dashboardFetch).mockImplementation(
      (url: string) =>
        new Promise((resolve) => {
          pending.set(url.includes("preq_a") ? "a" : "b", resolve);
        })
    );
    render(
      <PaymentRequestsWorkspace
        initialPaymentRequests={[requestA, requestB]}
        apiBaseUrl={null}
        apiKeys={[]}
        wallets={[]}
        counterparties={[]}
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
    await act(async () => pending.get("b")?.(linkResponse("token_b")));
    await act(async () => pending.get("a")?.(linkResponse("token_a")));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/\/pay\/token_b$/)).toBeTruthy();
    expect(within(dialog).queryByText(/token_a/)).toBeNull();
    expect(within(dialog).getAllByText(/80\.00/).length).toBeGreaterThan(0);
  });
});
