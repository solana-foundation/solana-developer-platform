// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { FireblocksTransferPolicy } from "./fireblocks-transfer-policy";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useOptionalDashboardWorkspace: () => ({ dashboardCacheScope: { userId: "user", orgId: "org" } }),
}));
beforeEach(() => window.localStorage.clear());
function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("Fireblocks policy guidance", () => {
  it("explains manual configuration without reading administrator-only APIs", () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    render(<FireblocksTransferPolicy enabled />, { wrapper });
    expect(screen.getByRole("status").textContent).toContain("recommended Editor role");
    expect(screen.getByRole("link", { name: "Open Fireblocks" }).getAttribute("href")).toBe(
      "https://console.fireblocks.io"
    );
    expect(screen.queryByRole("button", { name: "Set up transfer policy" })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("persists suppression across visits without changing whitelist warnings", async () => {
    const view = render(<FireblocksTransferPolicy enabled />, { wrapper });
    await userEvent.setup().click(screen.getByRole("button", { name: "Don’t show again" }));
    expect(screen.queryByRole("status")).toBeNull();
    view.unmount();
    render(<FireblocksTransferPolicy enabled />, { wrapper });
    expect(screen.queryByRole("status")).toBeNull();
    expect(Object.keys(window.localStorage).filter((key) => key.endsWith(":policy"))).toHaveLength(
      1
    );
    expect(
      Object.keys(window.localStorage).filter((key) => key.endsWith(":whitelist"))
    ).toHaveLength(0);
  });
  it("does not show Fireblocks guidance for other payment providers", () => {
    render(<FireblocksTransferPolicy enabled={false} />, { wrapper });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
