import { auth } from "@clerk/nextjs/server";
import type { PaymentsDashboardWallet } from "@sdp/types";
import { redirect } from "next/navigation";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getTranslations } from "@/i18n/server";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { createTimedTrace } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";
import { fetchPaymentsWallets } from "../payments/payments-page.data";
import { ApiKeyFlashSurface } from "./api-key-flash-surface";
import { type ApiKeyRecord, ApiKeysTableClient } from "./api-keys-table-client";
import { CreateApiKeyModal } from "./create-api-key-modal";

export const dynamic = "force-dynamic";

export default async function ApiKeysPage() {
  const t = await getTranslations();
  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const trace = createTimedTrace("dashboard.api_keys.page");
  const dashboardAccess = resolveDashboardAccess(orgRole);
  let apiKeys: ApiKeyRecord[] = [];
  let wallets: PaymentsDashboardWallet[] = [];

  try {
    const apiClient = await trace.step("create_sdp_api_client", () =>
      createSdpApiClient(trace.childContext("dashboard.api_keys.api"))
    );
    const [apiKeysResponse, walletsResponse] = await Promise.all([
      trace.step("fetch_api_keys", () =>
        apiClient.fetch<{ apiKeys: ApiKeyRecord[] }>("/v1/api-keys")
      ),
      dashboardAccess.capabilities.canManageApiKeys
        ? trace.step("fetch_wallets", () =>
            fetchPaymentsWallets(apiClient.request, { includeBalances: false })
          )
        : Promise.resolve({ ok: true as const, data: [] }),
    ]);

    apiKeys = apiKeysResponse.apiKeys;
    wallets = walletsResponse.ok ? (walletsResponse.data ?? []) : [];

    trace.log({
      ok: true,
      apiKeyCount: apiKeys.length,
      walletCount: wallets.length,
    });
  } catch (error) {
    trace.log({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }

  return (
    <div className="w-full flex flex-col gap-6">
      <ApiKeyFlashSurface />

      <Card>
        <CardHeader>
          <CardTitle>{t("DashboardCustody.existingApiKeys")}</CardTitle>
          <CardDescription>{t("DashboardCustody.existingApiKeysDescription")}</CardDescription>
          {dashboardAccess.capabilities.canManageApiKeys ? (
            <CardAction>
              <CreateApiKeyModal triggerLabel={t("DashboardCustody.newApiKey")} wallets={wallets} />
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent>
          {!dashboardAccess.capabilities.canManageApiKeys ? (
            <div className="mb-4 rounded-[10px] border border-border-default bg-fill-subtle px-3 py-2 text-xs text-secondary">
              {t("DashboardCustody.apiKeysViewOnly")}
            </div>
          ) : null}
          <div className="mb-4 rounded-[10px] border border-border-default bg-fill-subtle px-3 py-2 text-xs text-secondary">
            <p className="text-xs text-secondary">{t("DashboardCustody.apiKeyRotationHint")}</p>
          </div>
          <div className="@container/api-keys-table">
            <ApiKeysTableClient
              initialApiKeys={apiKeys}
              canManageApiKeys={dashboardAccess.capabilities.canManageApiKeys}
              wallets={wallets}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
