import { CreateApiKeyModal } from "@/app/dashboard/api-keys/create-api-key-modal";
import { CreateWalletModal } from "@/app/dashboard/custody/create-wallet-modal";
import { PageBody, PageHeader, PageLayout } from "@/components/layouts";
import { createSdpApiClient } from "@/lib/sdp-api";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import {
  buildHomeActivityRows,
  computeTodaysVolume,
  fetchCreateWalletProviders,
  fetchIssuanceTokens,
  fetchOrgIssuanceActivity,
} from "./home-page.data";
import { HomeWorkspace } from "./home-workspace";
import {
  normalizeAggregateBalances,
  resolveTotalBalance,
} from "./payments/payments-overview.utils";
import {
  fetchPaymentTransfers,
  fetchPaymentsAggregate,
  fetchPaymentsWallets,
} from "./payments/payments-page.data";

export default async function DashboardPage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect("/sign-in");
  }
  if (!orgId) {
    return null;
  }

  const apiClient = await createSdpApiClient();
  const [
    aggregateResult,
    transfersResult,
    walletsResult,
    walletProvidersResult,
    issuanceTokensResult,
  ] = await Promise.all([
    fetchPaymentsAggregate(apiClient.request),
    fetchPaymentTransfers(apiClient.request, 100),
    fetchPaymentsWallets(apiClient.request),
    fetchCreateWalletProviders(apiClient.request),
    fetchIssuanceTokens(apiClient.request, 10),
  ]);

  const issuanceActivityResult =
    issuanceTokensResult.ok && issuanceTokensResult.data
      ? await fetchOrgIssuanceActivity(apiClient.request, issuanceTokensResult.data)
      : { rows: [], error: null };

  const totalBalance = aggregateResult.data?.balances
    ? resolveTotalBalance(normalizeAggregateBalances(aggregateResult.data.balances))
    : null;
  const todaysVolume = transfersResult.data ? computeTodaysVolume(transfersResult.data) : null;
  const activityRows = buildHomeActivityRows(
    transfersResult.data ?? [],
    issuanceActivityResult.rows
  );

  const aggregateError = aggregateResult.ok ? null : "Balance data is unavailable right now.";
  const transfersError = transfersResult.ok ? null : "Payments activity is unavailable right now.";
  const walletProvidersError = walletProvidersResult.ok
    ? null
    : "Wallet providers are unavailable right now.";
  const issuanceTokensError = issuanceTokensResult.ok
    ? null
    : "Issuance activity is unavailable right now.";

  const activityError =
    activityRows.length === 0
      ? (transfersError ?? issuanceTokensError ?? issuanceActivityResult.error)
      : null;
  const activityNotice = [transfersError, issuanceTokensError, issuanceActivityResult.error]
    .filter(Boolean)
    .join(" ");

  return (
    <PageLayout width="default">
      <PageHeader
        variant="display"
        title="Home"
        action={
          <div className="flex flex-wrap items-center gap-3">
            <CreateApiKeyModal
              triggerLabel="Create API key"
              triggerVariant="secondary"
              wallets={walletsResult.data ?? []}
            />
            <CreateWalletModal
              triggerLabel="Create Wallet"
              providers={walletProvidersResult.data ?? []}
              disabled={(walletProvidersResult.data?.length ?? 0) === 0}
              disabledReason={
                walletProvidersError ??
                ((walletProvidersResult.data?.length ?? 0) === 0
                  ? "Connect a provider that supports additional wallet provisioning first."
                  : null) ??
                undefined
              }
            />
          </div>
        }
      />
      <PageBody>
        <HomeWorkspace
          totalBalance={totalBalance}
          totalBalanceError={aggregateError}
          todaysVolume={todaysVolume}
          todaysVolumeError={transfersError}
          activityRows={activityRows}
          activityError={activityError}
          activityNotice={activityNotice || null}
        />
      </PageBody>
    </PageLayout>
  );
}
