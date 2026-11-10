// @vitest-environment jsdom

import type { OrganizationRole } from "@sdp/types/roles";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as workspaceContext from "@/contexts/dashboard-workspace-context";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { setDashboardUrl } from "@/test/dashboard-navigation";
import { EnglishI18n } from "@/test/i18n";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { SidebarUserMenu } from "./sidebar-user-menu";

const clerk = vi.hoisted(() => ({ loaded: true }));
const member: { role: OrganizationRole } = { role: "member" };

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@clerk/nextjs", () => ({
  useUser: () => ({
    isLoaded: clerk.loaded,
    user: {
      fullName: "Jane Doe",
      imageUrl: "",
      primaryEmailAddress: { emailAddress: "jane@example.com" },
    },
  }),
  useClerk: () => ({ signOut: vi.fn() }),
}));
vi.mock("@/contexts/theme-context", () => ({
  THEME_PREFERENCES: ["system", "light", "dark"],
  useTheme: () => ({ theme: "light", preference: "system", setPreference: vi.fn() }),
}));
vi.mock("@/contexts/network-debug-context", () => ({
  useNetworkDebug: () => ({ available: false, enabled: false, setEnabled: vi.fn() }),
}));

beforeEach(() => {
  vi.mocked(vi.spyOn(workspaceContext, "useDashboardWorkspace"), {
    partial: true,
  }).mockImplementation(() => ({ dashboardAccess: resolveDashboardAccess(member.role) }));
});

afterEach(() => {
  cleanup();
  clerk.loaded = true;
  member.role = "member";
  vi.restoreAllMocks();
});

describe("SidebarUserMenu", () => {
  it("reserves the account row while Clerk resolves the user", () => {
    clerk.loaded = false;
    render(<SidebarUserMenu collapsed={false} />, { wrapper: EnglishI18n });

    expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByRole("button", { name: "Account menu" })).toBeNull();
  });

  it("opens on the identity and lists Account settings inside the URL's Project", async () => {
    setDashboardUrl(`/dashboard/${PRODUCTION_PROJECT.id}/payments`, {});
    const user = userEvent.setup();
    render(<SidebarUserMenu collapsed={false} />, { wrapper: EnglishI18n });

    await user.click(screen.getByRole("button", { name: "Account menu" }));

    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("Jane Doe")).toBeDefined();
    expect(within(menu).getByText("jane@example.com")).toBeDefined();
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent)
    ).toEqual(["Account settings", "Theme", "Send feedback", "API docs", "Sign out"]);
    expect(screen.getByRole("menuitem", { name: "Account settings" }).getAttribute("href")).toBe(
      `/dashboard/${PRODUCTION_PROJECT.id}/account`
    );
    // The link carries the page the person is on, for the email to name.
    expect(screen.getByRole("menuitem", { name: "Send feedback" }).getAttribute("href")).toBe(
      `/dashboard/${PRODUCTION_PROJECT.id}/feedback?from=%2Fdashboard%2F${PRODUCTION_PROJECT.id}%2Fpayments`
    );
  });

  it("leaves Send feedback out for a viewer, who cannot send it", async () => {
    member.role = "viewer";
    setDashboardUrl(`/dashboard/${PRODUCTION_PROJECT.id}/payments`, {});
    const user = userEvent.setup();
    render(<SidebarUserMenu collapsed={false} />, { wrapper: EnglishI18n });

    await user.click(screen.getByRole("button", { name: "Account menu" }));

    expect(
      within(screen.getByRole("menu"))
        .getAllByRole("menuitem")
        .map((item) => item.textContent)
    ).toEqual(["Account settings", "Theme", "API docs", "Sign out"]);
  });
});
