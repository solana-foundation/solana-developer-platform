import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { createTimedTrace } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";
import { auth } from "@clerk/nextjs/server";
import type { PaymentsDashboardWallet } from "@sdp/types";
import { redirect } from "next/navigation";
import { fetchPaymentsWallets } from "../payments/payments-page.data";
import { consumeApiKeyFlash } from "./actions";
import { type ApiKeyRecord, ApiKeysTableClient } from "./api-keys-table-client";
import { CreateApiKeyModal } from "./create-api-key-modal";
import { FlashClearTrigger } from "./flash-clear-trigger";
import { GeneratedApiKeyModal } from "./generated-key-modal";

export const dynamic = "force-dynamic";

export default async function ApiKeysPage() {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    redirect("/sign-in");
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const trace = createTimedTrace("dashboard.api_keys.page");
  const dashboardAccess = resolveDashboardAccess(orgRole);

  try {
    const apiClient = await trace.step("create_sdp_api_client", () =>
      createSdpApiClient(trace.childContext("dashboard.api_keys.api"))
    );
    const [flash, apiKeysResponse, walletsResponse] = await Promise.all([
      trace.step("consume_api_key_flash", () => consumeApiKeyFlash()),
      trace.step("fetch_api_keys", () =>
        apiClient.fetch<{ apiKeys: ApiKeyRecord[] }>("/v1/api-keys")
      ),
      dashboardAccess.capabilities.canManageApiKeys
        ? trace.step("fetch_wallets", () =>
            fetchPaymentsWallets(apiClient.request, { includeBalances: false })
          )
        : Promise.resolve({ ok: true as const, data: [] }),
    ]);

    const apiKeys = apiKeysResponse.apiKeys;
    const hasGeneratedKeyFlash = Boolean(flash?.key);
    const wallets: PaymentsDashboardWallet[] = walletsResponse.ok
      ? (walletsResponse.data ?? [])
      : [];

    trace.log({
      ok: true,
      apiKeyCount: apiKeys.length,
      walletCount: wallets.length,
      hasFlash: Boolean(flash),
      hasGeneratedKeyFlash,
    });

    return (
      <div className="w-full flex flex-col gap-6">
        {flash ? (
          <>
            {!hasGeneratedKeyFlash ? <FlashClearTrigger /> : null}
            {hasGeneratedKeyFlash ? (
              <GeneratedApiKeyModal
                keyValue={flash.key ?? ""}
                message={flash.message}
                keyPrefix={flash.keyPrefix}
              />
            ) : (
              <Card
                className={flash.level === "error" ? "border-[#c71f37]/25" : "border-[#1c1c1d]/12"}
              >
                <CardHeader>
                  <CardTitle>{flash.level === "error" ? "Action failed" : "Notice"}</CardTitle>
                  <CardDescription>{flash.message}</CardDescription>
                </CardHeader>
              </Card>
            )}
          </>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Existing API keys</CardTitle>
            <CardDescription>Active and historical keys for this workspace.</CardDescription>
            {dashboardAccess.capabilities.canManageApiKeys ? (
              <CardAction>
                <CreateApiKeyModal triggerLabel="New API key" wallets={wallets} />
              </CardAction>
            ) : null}
          </CardHeader>
          <CardContent>
            {!dashboardAccess.capabilities.canManageApiKeys ? (
              <div className="mb-4 rounded-[10px] border border-[rgba(28,28,29,0.14)] bg-[rgba(28,28,29,0.03)] px-3 py-2 text-xs text-[rgba(28,28,29,0.72)]">
                You can view API keys, but only admins can create, rotate, or delete them.
              </div>
            ) : null}
            <div className="mb-4 rounded-[10px] border border-[rgba(28,28,29,0.14)] bg-[rgba(28,28,29,0.03)] px-3 py-2 text-xs text-[rgba(28,28,29,0.72)]">
              <p className="text-xs text-[rgba(28,28,29,0.72)]">
                Rotation hint: rotate active keys only. The dashboard uses a 24-hour grace period;
                use the API for custom grace values (0-168h). New key secrets are shown once.
              </p>
            </div>
            <ApiKeysTableClient
              initialApiKeys={apiKeys}
              canManageApiKeys={dashboardAccess.capabilities.canManageApiKeys}
            />
          </CardContent>
        </Card>
      </div>
    );
  } catch (error) {
    trace.log({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }
}
