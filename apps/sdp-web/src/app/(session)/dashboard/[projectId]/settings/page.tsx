import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { DashboardQuickStart } from "@/components/dashboard-quick-start";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { requestMemberRole } from "@/lib/sdp-api";
import { LeaveOrganizationSection } from "./leave-organization-section";
import { MainnetAccessSection } from "./mainnet-access-section";
import { MembersSection } from "./members-section";
import { OrganizationAccessSection } from "./organization-access-section";
import { OrganizationAlertEmailsSection } from "./organization-alert-emails-section";
import { OrganizationDetailsSection } from "./organization-details-section";
import { SettingsWorkspace } from "./settings-workspace";

/** Anything that is not a positive integer falls back to the first page. */
function resolveMembersPage(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * Organization settings, as tabs. General: the organization's name and ID, the quick start for
 * API key managers, mainnet access and email alerts for admins, and leaving for everyone else.
 * Members, for admins: inviting and the member list. Security, for admins: the API-key IP
 * allowlist.
 *
 * @param props - The route props.
 * @param props.searchParams - The query, carrying the members page.
 * @returns The rendered settings page.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const membersPage = resolveMembersPage((await searchParams).membersPage);

  const { orgId } = await auth();
  if (!orgId) {
    redirect("/dashboard");
  }

  const dashboardAccess = resolveDashboardAccess(await requestMemberRole());
  const { canManageApiKeys, canManageOrgSettings } = dashboardAccess.capabilities;

  return (
    <SettingsWorkspace
      general={
        <div className="@container flex w-full flex-col gap-2.5">
          <OrganizationDetailsSection />
          {canManageApiKeys ? <DashboardQuickStart variant="settings" /> : null}
          {canManageOrgSettings ? <MainnetAccessSection /> : null}
          {canManageOrgSettings ? <OrganizationAlertEmailsSection /> : null}
          {/* Admins cannot leave; another admin removes them. */}
          {dashboardAccess.role !== "admin" ? <LeaveOrganizationSection /> : null}
        </div>
      }
      members={
        // canManageOrgSettings resolves to org:write, which is what inviting a member requires.
        canManageOrgSettings ? (
          <div className="@container flex w-full flex-col gap-2.5">
            <MembersSection page={membersPage} />
          </div>
        ) : null
      }
      security={
        canManageOrgSettings ? (
          <div className="@container flex w-full flex-col gap-2.5">
            <OrganizationAccessSection />
          </div>
        ) : null
      }
    />
  );
}
