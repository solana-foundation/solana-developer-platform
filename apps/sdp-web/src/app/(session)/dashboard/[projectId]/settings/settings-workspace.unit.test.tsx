// @vitest-environment jsdom
import type { OrganizationRole } from "@sdp/types/roles";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { SANDBOX_PROJECT } from "@/test/projects";
import { restoreWindowLocation } from "@/test/window-location";
import { SettingsWorkspace } from "./settings-workspace";

const workspace = vi.hoisted((): { role: OrganizationRole } => ({ role: "member" }));

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({ dashboardAccess: resolveDashboardAccess(workspace.role) }),
}));
vi.mock("@/components/dashboard-quick-start", () => ({
  DashboardQuickStart: () => "[quick start]",
}));
vi.mock("./organization-details-section", () => ({
  OrganizationDetailsSection: () => "[details]",
}));
vi.mock("./mainnet-access-section", () => ({ MainnetAccessSection: () => "[mainnet]" }));
vi.mock("./organization-alert-emails-section", () => ({
  OrganizationAlertEmailsSection: () => "[alert emails]",
}));
vi.mock("./leave-organization-section", () => ({ LeaveOrganizationSection: () => "[leave]" }));
vi.mock("./members-section", () => ({ MembersSection: () => "[members]" }));
vi.mock("./organization-access-section", () => ({
  OrganizationAccessSection: () => "[allowlist]",
}));

const ADMIN_GENERAL = "[details][quick start][mainnet][alert emails]";
const MEMBER_GENERAL = "[details][leave]";

afterEach(() => {
  cleanup();
  restoreWindowLocation();
});

describe("SettingsWorkspace", () => {
  it.each<[OrganizationRole, string, string]>([
    ["admin", "", ADMIN_GENERAL],
    ["admin", "?tab=members", "[members]"],
    ["admin", "?tab=security", "[allowlist]"],
    ["admin", "?tab=unknown", ADMIN_GENERAL],
    ["member", "", MEMBER_GENERAL],
    ["member", "?tab=members", MEMBER_GENERAL],
    ["member", "?tab=security", MEMBER_GENERAL],
  ])("shows SDP's %s role at '%s' the sections it holds: %s", (role, query, shown) => {
    window.history.replaceState(null, "", `/dashboard/${SANDBOX_PROJECT.id}/settings${query}`);
    workspace.role = role;

    const { container } = render(<SettingsWorkspace />);

    expect(container.textContent).toBe(shown);
  });
});
