// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { FireblocksTransferPolicy } from "./fireblocks-transfer-policy";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/lib/dashboard-fetch", () => ({ dashboardFetch: vi.fn() }));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useOptionalDashboardWorkspace: () => ({ dashboardCacheScope: { userId: "user", orgId: "org" } }),
}));
beforeEach(() => window.localStorage.clear());
const selection = {
  walletId: "wallet",
  counterpartyId: "contact",
  accountId: "address",
  address: "destination",
  token: "SOL",
  amount: "0.01",
};
function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}
function ok(data: unknown) {
  return { ok: true as const, status: 200, data: { data } };
}
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
describe("Read-only Fireblocks policy warning", () => {
  it.each([
    ["permission_required", /API user cannot read policies/],
    ["missing", /No matching Fireblocks transfer policy/],
    ["blocked", /policy blocks this payment/],
    ["unknown", /could not determine whether Fireblocks allows/],
  ])("explains %s and offers no policy editor or write actions", async (state, message) => {
    vi.mocked(dashboardFetch).mockResolvedValue(ok({ state }));
    render(<FireblocksTransferPolicy enabled selection={selection} />, { wrapper });
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set up transfer policy" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("link", { name: "Open Fireblocks" }).getAttribute("href")).toBe(
      "https://console.fireblocks.io"
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(dashboardFetch).toHaveBeenCalledTimes(2));
    expect(
      vi
        .mocked(dashboardFetch)
        .mock.calls.every(([, opts]) => !opts?.method || opts.method === "GET")
    ).toBe(true);
  });
  it("persists suppression across page visits without affecting the whitelist preference", async () => {
    vi.mocked(dashboardFetch).mockResolvedValue(ok({ state: "missing" }));
    const view = render(<FireblocksTransferPolicy enabled selection={selection} />, { wrapper });
    await userEvent.setup().click(await screen.findByRole("button", { name: "Don’t show again" }));
    expect(screen.queryByRole("status")).toBeNull();
    view.unmount();
    render(<FireblocksTransferPolicy enabled selection={selection} />, { wrapper });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 550));
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect(dashboardFetch).toHaveBeenCalledTimes(1);
    expect(Object.keys(window.localStorage).filter((k) => k.endsWith(":policy"))).toHaveLength(1);
    expect(Object.keys(window.localStorage).filter((k) => k.endsWith(":whitelist"))).toHaveLength(
      0
    );
  });
  it("drops a stale reply when the destination changes and stays quiet for a covered payment", async () => {
    let resolveFirst: ((value: ReturnType<typeof ok>) => void) | undefined;
    vi.mocked(dashboardFetch)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValue(ok({ state: "covered" }));
    const view = render(<FireblocksTransferPolicy enabled selection={selection} />, { wrapper });
    await waitFor(() => expect(resolveFirst).toBeDefined());
    view.rerender(
      <FireblocksTransferPolicy enabled selection={{ ...selection, address: "another" }} />
    );
    await act(async () => {
      resolveFirst?.(ok({ state: "missing" }));
    });
    await waitFor(() => expect(dashboardFetch).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
