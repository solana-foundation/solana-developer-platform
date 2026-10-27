import type { OrganizationRole } from "@sdp/types/roles";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardQuickStart } from "@/components/dashboard-quick-start";
import * as sdpApi from "@/lib/sdp-api";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { setPageRequest } from "@/test/request-project";

const mocks = vi.hoisted(() => ({ auth: vi.fn() }));

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("next/headers", () => import("@/test/next-headers"));

import { LeaveOrganizationCard } from "./leave-organization-card";
import { MembersSection } from "./members-section";
import { OrganizationAccessSection } from "./organization-access-section";
import SettingsPage from "./page";

function sectionTypes(page: ReactElement<{ children: ReactNode }>): ReactElement["type"][] {
  return Children.toArray(page.props.children).flatMap((child) =>
    isValidElement(child) ? [child.type] : []
  );
}

describe("settings page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPageRequest(`/dashboard/${PRODUCTION_PROJECT.id}/settings`);
    mocks.auth.mockResolvedValue({ userId: "user_test", orgId: "org_test" });
  });

  it.each<[OrganizationRole, ReactElement["type"][]]>([
    ["admin", [DashboardQuickStart, MembersSection, OrganizationAccessSection]],
    ["member", [LeaveOrganizationCard]],
  ])("renders the sections SDP's %s role holds", async (role, sections) => {
    vi.spyOn(sdpApi, "requestMemberRole").mockResolvedValue(role);

    const page = await SettingsPage({ searchParams: Promise.resolve({}) });

    expect(sectionTypes(page)).toEqual(sections);
  });
});
