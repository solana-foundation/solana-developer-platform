import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
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
 * RPC selection used to live here (HOO-787). It is managed on each provider's
 * page under Integrations now, which is also where the fallback warning for a
 * provider the deployment no longer offers is raised — so this page no longer
 * loads the organization or its provider availability at all.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const membersPage = resolveMembersPage((await searchParams).membersPage);

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
      {/* canManageOrgSettings resolves to org:write, which is what inviting a
          member requires. */}
      {dashboardAccess.capabilities.canManageOrgSettings ? (
        <MembersSection page={membersPage} />
      ) : null}
    </div>
  );
}
