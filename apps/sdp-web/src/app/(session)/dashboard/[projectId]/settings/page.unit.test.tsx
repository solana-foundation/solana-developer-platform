import type { OrganizationRole } from "@sdp/types/roles";
import {
  Children,
  type ComponentProps,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardQuickStart } from "@/components/dashboard-quick-start";
import * as sdpApi from "@/lib/sdp-api";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { setPageRequest } from "@/test/request-project";

const mocks = vi.hoisted(() => ({ auth: vi.fn() }));

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("next/headers", () => import("@/test/next-headers"));

import { LeaveOrganizationSection } from "./leave-organization-section";
import { MainnetAccessSection } from "./mainnet-access-section";
import { MembersSection } from "./members-section";
import { OrganizationAccessSection } from "./organization-access-section";
import { OrganizationAlertEmailsSection } from "./organization-alert-emails-section";
import { OrganizationDetailsSection } from "./organization-details-section";
import SettingsPage from "./page";
import { SettingsWorkspace } from "./settings-workspace";

type SectionTypes = ReactElement["type"][];

function sectionTypes(panel: ReactNode): SectionTypes | null {
  if (!isValidElement<{ children: ReactNode }>(panel)) return null;
  return Children.toArray(panel.props.children).flatMap((child) =>
    isValidElement(child) ? [child.type] : []
  );
}

describe("settings page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPageRequest(`/dashboard/${PRODUCTION_PROJECT.id}/settings`);
    mocks.auth.mockResolvedValue({ userId: "user_test", orgId: "org_test" });
  });

  it.each<
    [
      OrganizationRole,
      { general: SectionTypes; members: SectionTypes | null; security: SectionTypes | null },
    ]
  >([
    [
      "admin",
      {
        general: [
          OrganizationDetailsSection,
          DashboardQuickStart,
          MainnetAccessSection,
          OrganizationAlertEmailsSection,
        ],
        members: [MembersSection],
        security: [OrganizationAccessSection],
      },
    ],
    [
      "member",
      {
        general: [OrganizationDetailsSection, LeaveOrganizationSection],
        members: null,
        security: null,
      },
    ],
  ])("fills each tab with the sections SDP's %s role holds", async (role, panels) => {
    vi.spyOn(sdpApi, "requestMemberRole").mockResolvedValue(role);

    const page: ReactElement<ComponentProps<typeof SettingsWorkspace>> = await SettingsPage({
      searchParams: Promise.resolve({}),
    });

    expect(page.type).toBe(SettingsWorkspace);
    expect({
      general: sectionTypes(page.props.general),
      members: sectionTypes(page.props.members),
      security: sectionTypes(page.props.security),
    }).toEqual(panels);
  });
});
