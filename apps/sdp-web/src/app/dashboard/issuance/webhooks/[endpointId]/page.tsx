import { auth } from "@clerk/nextjs/server";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "@/i18n/server";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { createSdpApiClient, SdpApiResponseError } from "@/lib/sdp-api";
import type { WebhookEndpointView } from "../webhook-endpoints.data";
import { fetchWebhookEndpointServer } from "../webhook-endpoints.server";
import { WebhookEndpointDetail } from "./webhook-endpoint-detail";

export const dynamic = "force-dynamic";

export default async function WebhookEndpointPage({
  params,
}: {
  params: Promise<{ endpointId: string }>;
}) {
  const [t, { userId, orgId, orgRole }, { endpointId }] = await Promise.all([
    getTranslations(),
    auth(),
    params,
  ]);
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

  let endpoint: WebhookEndpointView;
  try {
    const apiClient = await createSdpApiClient();
    endpoint = await fetchWebhookEndpointServer(apiClient, endpointId);
  } catch (error) {
    if (error instanceof SdpApiResponseError && error.status === 404) {
      notFound();
    }
    throw error;
  }

  return (
    <WebhookEndpointDetail
      initialEndpoint={endpoint}
      canManage={dashboardAccess.capabilities.canManageWebhooks}
    />
  );
}
