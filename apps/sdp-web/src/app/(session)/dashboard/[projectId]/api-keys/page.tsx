import { auth } from "@clerk/nextjs/server";
import { Callout } from "@sdp/ui/callout";
import { redirect } from "next/navigation";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { getTranslations } from "@/i18n/server";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { createTimedTrace } from "@/lib/request-tracing";
import { createSdpApiClient, requestMemberRole } from "@/lib/sdp-api";
import type { ApiKeyListItem } from "./api-key-presentation";
import { ApiKeysList } from "./api-keys-list";

export const dynamic = "force-dynamic";

export default async function ApiKeysPage() {
  const [t, { orgId }] = await Promise.all([getTranslations(), auth()]);
  if (!orgId) {
    redirect("/dashboard");
  }

  const trace = createTimedTrace("dashboard.api_keys.page");
  const { canManageApiKeys } = resolveDashboardAccess(await requestMemberRole()).capabilities;
  let apiKeys: ApiKeyListItem[];
  try {
    const apiClient = await trace.step("create_sdp_api_client", () =>
      createSdpApiClient(trace.childContext("dashboard.api_keys.api"))
    );
    const response = await trace.step("fetch_api_keys", () =>
      apiClient.fetch<{ apiKeys: ApiKeyListItem[] }>("/v1/api-keys")
    );
    apiKeys = response.apiKeys;
    trace.log({ ok: true, apiKeyCount: apiKeys.length });
  } catch (error) {
    trace.log({ ok: false, error: error instanceof Error ? error.message : "Unknown error" });
    throw error;
  }

  return (
    <DashboardWorkspaceOverviewPanel className="flex flex-col gap-5">
      {canManageApiKeys ? null : (
        <Callout variant="neutral">{t("DashboardCustody.apiKeysViewOnly")}</Callout>
      )}
      <ApiKeysList apiKeys={apiKeys} canManageApiKeys={canManageApiKeys} now={Date.now()} />
    </DashboardWorkspaceOverviewPanel>
  );
}
