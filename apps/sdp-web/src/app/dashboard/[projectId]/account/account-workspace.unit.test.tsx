// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnglishI18n } from "@/test/i18n";
import { SANDBOX_PROJECT } from "@/test/projects";
import { restoreWindowLocation, setWindowPathname } from "@/test/window-location";
import { AccountWorkspace } from "./account-workspace";

const clerk = vi.hoisted(() => ({
  user: {
    id: "user_test_jane",
    fullName: "Jane Doe",
    firstName: "Jane",
    lastName: "Doe",
    username: null,
    hasImage: false,
    imageUrl: "",
    primaryEmailAddressId: "idn_test_primary",
    emailAddresses: [],
    passwordEnabled: true,
    getSessions: vi.fn(async () => []),
  },
}));

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@clerk/nextjs", () => ({
  useUser: () => ({ user: clerk.user }),
  useSession: () => ({ session: { id: "sess_test_current" } }),
  useOrganization: () => ({ organization: { id: "org_test_acme", name: "Acme" } }),
  useReverification: (action: unknown) => action,
}));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({ dashboardAccess: { role: "admin" } }),
}));

afterEach(() => {
  cleanup();
  restoreWindowLocation();
});

describe("AccountWorkspace", () => {
  it.each([
    ["?tab=security", "Password"],
    ["?tab=billing", "Photo"],
  ])("renders %s as the tab headed %s", async (search, heading) => {
    setWindowPathname(`/dashboard/${SANDBOX_PROJECT.id}/account${search}`);
    render(
      <EnglishI18n>
        <SWRConfig value={{ provider: () => new Map() }}>
          <AccountWorkspace />
        </SWRConfig>
      </EnglishI18n>
    );

    expect(await screen.findByRole("heading", { name: heading })).toBeDefined();
  });
});
