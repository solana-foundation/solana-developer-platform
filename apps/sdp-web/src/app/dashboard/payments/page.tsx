import { createSdpApiClient } from "@/lib/sdp-api";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { fetchActiveApiKeys, resolvePlaygroundApiBaseUrl } from "../playground-api-data";
import { fetchPaymentTransfers, fetchPaymentsWallets } from "./payments-page.data";
import { PaymentsWorkspace } from "./payments-workspace";

export default async function PaymentsPage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect("/sign-in");
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const apiBaseUrl = resolvePlaygroundApiBaseUrl();
  const apiClient = await createSdpApiClient();
  const [apiKeysResult, walletsResult, transfersResult] = await Promise.all([
    fetchActiveApiKeys(apiClient.request),
    fetchPaymentsWallets(apiClient.request, { includeBalances: true }),
    fetchPaymentTransfers(apiClient.request),
  ]);
  const apiKeys = apiKeysResult.data ?? [];
  const wallets = walletsResult.data ?? [];
  const transfers = transfersResult.data ?? [];
  const walletsError = walletsResult.ok
    ? null
    : `Wallet API ${walletsResult.status ?? "unavailable"}: ${walletsResult.error ?? "Unknown error"}`;
  const transfersError = transfersResult.ok
    ? null
    : `Transfer API ${transfersResult.status ?? "unavailable"}: ${transfersResult.error ?? "Unknown error"}`;

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <PaymentsWorkspace
        apiBaseUrl={apiBaseUrl}
        apiKeys={apiKeys}
        wallets={wallets}
        walletsError={walletsError}
        transfers={transfers}
        transfersError={transfersError}
      />
    </div>
  );
}
