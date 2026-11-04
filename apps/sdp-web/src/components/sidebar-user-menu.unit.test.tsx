// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { dashboardRouter, setDashboardUrl } from "@/test/dashboard-navigation";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { SidebarUserMenu } from "./sidebar-user-menu";

const clerk = vi.hoisted(() => ({ loaded: true }));

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@sentry/nextjs", () => ({ getFeedback: () => undefined }));
vi.mock("@clerk/nextjs", () => ({
  useUser: () => ({
    isLoaded: clerk.loaded,
    user: {
      fullName: "Jane Doe",
      imageUrl: "",
      primaryEmailAddress: { emailAddress: "jane@example.com" },
    },
  }),
  useClerk: () => ({ openUserProfile: vi.fn(), signOut: vi.fn() }),
}));
vi.mock("@/contexts/theme-context", () => ({
  THEME_PREFERENCES: ["system", "light", "dark"],
  useTheme: () => ({ theme: "light", preference: "system", setPreference: vi.fn() }),
}));
vi.mock("@/contexts/network-debug-context", () => ({
  useNetworkDebug: () => ({ available: false, enabled: false, setEnabled: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  clerk.loaded = true;
  document.documentElement.lang = "";
});

describe("SidebarUserMenu", () => {
  it("reserves the account row while Clerk resolves the user", () => {
    clerk.loaded = false;
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <SidebarUserMenu collapsed={false} menuSide="right" />
      </I18nProvider>
    );
    expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByRole("button", { name: "Account menu" })).toBeNull();
  });

  it("links Settings inside the URL's Project and switches the language", async () => {
    setDashboardUrl(`/dashboard/${PRODUCTION_PROJECT.id}/payments`, {});
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <SidebarUserMenu collapsed={false} menuSide="right" />
      </I18nProvider>
    );

    await user.click(screen.getByRole("button", { name: "Account menu" }));
    expect(screen.getByRole("menuitem", { name: "Settings" }).getAttribute("href")).toBe(
      `/dashboard/${PRODUCTION_PROJECT.id}/settings`
    );
    const row = screen.getByRole("menuitem", { name: /Language/ });
    expect(row.textContent).toContain("English");

    await user.click(row);
    (await screen.findByRole("menuitemradio", { name: /Français/ })).focus();
    await user.keyboard("{Enter}");

    expect(document.documentElement.lang).toBe("fr");
    expect(dashboardRouter.refresh).toHaveBeenCalledTimes(1);
  });
});
