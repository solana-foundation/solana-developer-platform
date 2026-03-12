import { IssuanceHeaderTabs } from "@/components/issuance-header-tabs";
import { PageHeader, PageLayout } from "@/components/layouts";
import { createSdpApiClient } from "@/lib/sdp-api";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { fetchActiveApiKeys, resolvePlaygroundApiBaseUrl } from "../playground-api-data";
import {
  fetchPaymentTransfers,
  fetchPaymentsAggregate,
  fetchPaymentsWallets,
} from "./payments-page.data";
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
  const [apiKeysResult, walletsResult, aggregateResult, transfersResult] = await Promise.all([
    fetchActiveApiKeys(apiClient.request),
    fetchPaymentsWallets(apiClient.request),
    fetchPaymentsAggregate(apiClient.request),
    fetchPaymentTransfers(apiClient.request),
  ]);
  const apiKeys = apiKeysResult.data ?? [];
  const wallets = walletsResult.data ?? [];
  const aggregate = aggregateResult.data ?? null;
  const transfers = transfersResult.data ?? [];
  const walletsError = walletsResult.ok
    ? null
    : `Wallet API ${walletsResult.status ?? "unavailable"}: ${walletsResult.error ?? "Unknown error"}`;
  const aggregateError = aggregateResult.ok
    ? null
    : `Wallet aggregate API ${aggregateResult.status ?? "unavailable"}: ${aggregateResult.error ?? "Unknown error"}`;
  const transfersError = transfersResult.ok
    ? null
    : `Transfer API ${transfersResult.status ?? "unavailable"}: ${transfersResult.error ?? "Unknown error"}`;

  return (
    <PageLayout width="full">
      <PageHeader variant="wide" title="Payments" tabs={<IssuanceHeaderTabs />} />
      <PaymentsWorkspace
        apiBaseUrl={apiBaseUrl}
        apiKeys={apiKeys}
        wallets={wallets}
        walletsError={walletsError}
        aggregate={aggregate}
        aggregateError={aggregateError}
        transfers={transfers}
        transfersError={transfersError}
      />
    </PageLayout>
  );
}
