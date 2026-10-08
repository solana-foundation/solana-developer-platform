import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { DashboardQuickStart } from "@/components/dashboard-quick-start";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { MembersSection } from "./members-section";

/** Anything that is not a positive integer falls back to the first page. */
function resolveMembersPage(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * Organization settings: the quick start for API key managers and the members
 * section for organization writers.
 *
 * @param props - The route props.
 * @param props.searchParams - The query, carrying the members page.
 * @returns The rendered settings page.
 */
export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  const membersPage = resolveMembersPage(query.membersPage);

  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const dashboardAccess = resolveDashboardAccess(orgRole);

  return (
    <div className="w-full flex flex-col gap-6">
      {dashboardAccess.capabilities.canManageApiKeys ? (
        <DashboardQuickStart variant="settings" />
      ) : null}
      {/* canManageOrgSettings resolves to org:write, which is what inviting a
          member requires. */}
      {dashboardAccess.capabilities.canManageOrgSettings ? (
        <MembersSection projectId={projectId} page={membersPage} />
      ) : null}
    </div>
  );
}
