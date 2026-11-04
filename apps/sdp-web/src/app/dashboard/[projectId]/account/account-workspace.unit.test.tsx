// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_PROJECT } from "@/test/projects";
import { restoreWindowLocation, setWindowPathname } from "@/test/window-location";
import { AccountWorkspace } from "./account-workspace";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/app/dashboard/[projectId]/account/account-profile", () => ({
  AccountProfile: () => <p>Profile tab</p>,
}));
vi.mock("@/app/dashboard/[projectId]/account/account-security", () => ({
  AccountSecurity: () => <p>Security tab</p>,
}));
vi.mock("@/app/dashboard/[projectId]/account/account-preferences", () => ({
  AccountPreferences: () => <p>Preferences tab</p>,
}));

afterEach(() => {
  cleanup();
  restoreWindowLocation();
});

describe("AccountWorkspace", () => {
  it.each([
    ["?tab=security", "Security tab"],
    ["?tab=billing", "Profile tab"],
  ])("renders %s as the %s", (search, panel) => {
    setWindowPathname(`/dashboard/${SANDBOX_PROJECT.id}/account${search}`);
    render(<AccountWorkspace />);

    expect(screen.getByText(panel)).toBeDefined();
  });
});
