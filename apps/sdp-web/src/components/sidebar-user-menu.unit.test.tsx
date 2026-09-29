// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { SidebarUserMenu } from "./sidebar-user-menu";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@sentry/nextjs", () => ({ getFeedback: () => undefined }));
vi.mock("@clerk/nextjs", () => ({
  useUser: () => ({
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
  router.refresh.mockClear();
  document.documentElement.lang = "";
});

describe("SidebarUserMenu", () => {
  it("carries the language: the row names the current one and switches to another", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <SidebarUserMenu collapsed={false} canManageOrgSettings menuSide="right" />
      </I18nProvider>
    );

    await user.click(screen.getByRole("button", { name: "Account menu" }));
    const row = screen.getByRole("menuitem", { name: /Language/ });
    expect(row.textContent).toContain("English");

    await user.click(row);
    // jsdom does not pass Radix's pointer checks inside a submenu; the keyboard takes the
    // same path to the choice.
    (await screen.findByRole("menuitemradio", { name: /Français/ })).focus();
    await user.keyboard("{Enter}");

    // The preference cookie is Secure, which jsdom's http page does not keep.
    expect(document.documentElement.lang).toBe("fr");
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });
});
