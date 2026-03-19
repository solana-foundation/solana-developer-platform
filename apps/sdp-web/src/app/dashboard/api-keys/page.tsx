import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { createSdpApiClient, sdpApiFetch } from "@/lib/sdp-api";
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
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect("/sign-in");
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const apiClient = await createSdpApiClient();
  const [flash, apiKeysResponse, walletsResponse] = await Promise.all([
    consumeApiKeyFlash(),
    sdpApiFetch<{ apiKeys: ApiKeyRecord[] }>("/v1/api-keys"),
    fetchPaymentsWallets(apiClient.request, { includeBalances: false }),
  ]);

  const apiKeys = apiKeysResponse.apiKeys;
  const hasGeneratedKeyFlash = Boolean(flash?.key);
  const wallets: PaymentsDashboardWallet[] = walletsResponse.ok ? (walletsResponse.data ?? []) : [];

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
          <CardAction>
            <CreateApiKeyModal triggerLabel="New API key" wallets={wallets} />
          </CardAction>
        </CardHeader>
        <CardContent>
          <div className="mb-4 rounded-[10px] border border-[rgba(28,28,29,0.14)] bg-[rgba(28,28,29,0.03)] px-3 py-2 text-xs text-[rgba(28,28,29,0.72)]">
            <p className="text-xs text-[rgba(28,28,29,0.72)]">
              Rotation hint: rotate active keys only. The dashboard uses a 24-hour grace period; use
              the API for custom grace values (0-168h). New key secrets are shown once.
            </p>
          </div>
          <ApiKeysTableClient initialApiKeys={apiKeys} />
        </CardContent>
      </Card>
    </div>
  );
}
