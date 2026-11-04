// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setDashboardUrl } from "@/test/dashboard-navigation";
import { EnglishI18n } from "@/test/i18n";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { SidebarUserMenu } from "./sidebar-user-menu";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@sentry/nextjs", () => ({ getFeedback: () => undefined }));
vi.mock("@clerk/nextjs", () => ({
  useUser: () => ({
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

afterEach(() => {
  cleanup();
});

describe("SidebarUserMenu", () => {
  it("opens on the identity and lists Account settings inside the URL's Project", async () => {
    setDashboardUrl(`/dashboard/${PRODUCTION_PROJECT.id}/payments`, {});
    const user = userEvent.setup();
    render(<SidebarUserMenu collapsed={false} menuSide="right" />, { wrapper: EnglishI18n });

    await user.click(screen.getByRole("button", { name: "Account menu" }));

    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("Jane Doe")).toBeDefined();
    expect(within(menu).getByText("jane@example.com")).toBeDefined();
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent)
    ).toEqual(["Account settings", "Theme", "API Docs", "Feedback", "Sign out"]);
    expect(screen.getByRole("menuitem", { name: "Account settings" }).getAttribute("href")).toBe(
      `/dashboard/${PRODUCTION_PROJECT.id}/account`
    );
  });
});
