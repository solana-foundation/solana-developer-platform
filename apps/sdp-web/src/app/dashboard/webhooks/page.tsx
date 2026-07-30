import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getTranslations } from "@/i18n/server";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { WebhookEndpointsWorkspace } from "./webhook-endpoints-workspace";

export const dynamic = "force-dynamic";

export default async function WebhooksPage() {
  const [t, { userId, orgId, orgRole }] = await Promise.all([getTranslations(), auth()]);
  if (!userId) redirect(await getAuthEntryPath());
  if (!orgId) redirect("/dashboard");

  const dashboardAccess = resolveDashboardAccess(orgRole);
  if (!dashboardAccess.capabilities.canReadWebhooks) {
    return (
      <div className="flex h-full min-h-[420px] items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h1 className="text-xl font-medium text-primary">{t("DashboardWebhooks.noAccess")}</h1>
          <p className="mt-2 text-sm text-secondary">
            {t("DashboardWebhooks.noAccessDescription")}
          </p>
        </div>
      </div>
    );
  }

  // No server data fetch: the list is client-SWR (the post-Phase-5 pattern) so
  // mutations refresh in place without a duplicate server fetch path.
  return <WebhookEndpointsWorkspace canManage={dashboardAccess.capabilities.canManageWebhooks} />;
}
