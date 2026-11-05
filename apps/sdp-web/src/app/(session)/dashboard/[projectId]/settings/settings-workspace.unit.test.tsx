// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_PROJECT } from "@/test/projects";
import { restoreWindowLocation } from "@/test/window-location";
import { SettingsWorkspace } from "./settings-workspace";

const workspace = vi.hoisted(() => ({ canManageOrgSettings: false }));

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    dashboardAccess: { capabilities: { canManageOrgSettings: workspace.canManageOrgSettings } },
  }),
}));

afterEach(() => {
  cleanup();
  restoreWindowLocation();
});

describe("SettingsWorkspace", () => {
  it.each<[string, boolean, string]>([
    ["", true, "General panel"],
    ["?tab=members", true, "Members panel"],
    ["?tab=security", true, "Security panel"],
    ["?tab=unknown", true, "General panel"],
    ["", false, "General panel"],
    ["?tab=members", false, "General panel"],
    ["?tab=security", false, "General panel"],
    ["?tab=unknown", false, "General panel"],
  ])("shows '%s' to a person whose canManageOrgSettings is %s: %s", (query, canManage, shown) => {
    window.history.replaceState(null, "", `/dashboard/${SANDBOX_PROJECT.id}/settings${query}`);
    workspace.canManageOrgSettings = canManage;

    const { container } = render(
      <SettingsWorkspace
        general={<p>General panel</p>}
        members={<p>Members panel</p>}
        security={<p>Security panel</p>}
      />
    );

    expect(container.textContent).toBe(shown);
  });
});
