import { createTimedTrace } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { fetchActiveApiKeys, resolvePlaygroundApiBaseUrl } from "../playground-api-data";
import {
  fetchPaymentTransfers,
  fetchPaymentsAggregate,
  fetchPaymentsIssuedTokenSymbols,
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

  const trace = createTimedTrace("dashboard.payments.page");

  try {
    const apiBaseUrl = resolvePlaygroundApiBaseUrl();
    const apiClient = await trace.step("create_sdp_api_client", () =>
      createSdpApiClient(trace.childContext("dashboard.payments.api"))
    );
    const [
      apiKeysResult,
      walletsResult,
      aggregateResult,
      transfersResult,
      issuedTokenSymbolsResult,
    ] = await Promise.all([
      trace.step("fetch_active_api_keys", () => fetchActiveApiKeys(apiClient.request)),
      trace.step("fetch_payments_wallets", () =>
        fetchPaymentsWallets(apiClient.request, { includeBalances: true })
      ),
      trace.step("fetch_payments_aggregate", () => fetchPaymentsAggregate(apiClient.request)),
      trace.step("fetch_payment_transfers", () => fetchPaymentTransfers(apiClient.request)),
      trace.step("fetch_payment_token_symbols", () =>
        fetchPaymentsIssuedTokenSymbols(apiClient.request)
      ),
    ]);
    const apiKeys = apiKeysResult.data ?? [];
    const wallets = walletsResult.data ?? [];
    const aggregate = aggregateResult.data ?? null;
    const transfers = transfersResult.data ?? [];
    const issuedTokenSymbolsByMint = Object.fromEntries(
      (issuedTokenSymbolsResult.data ?? []).map((token) => [token.mintAddress, token.symbol])
    );
    const walletsError = walletsResult.ok
      ? null
      : `Wallet API ${walletsResult.status ?? "unavailable"}: ${walletsResult.error ?? "Unknown error"}`;
    const aggregateError = aggregateResult.ok
      ? null
      : `Wallet aggregate API ${aggregateResult.status ?? "unavailable"}: ${aggregateResult.error ?? "Unknown error"}`;
    const transfersError = transfersResult.ok
      ? null
      : `Transfer API ${transfersResult.status ?? "unavailable"}: ${transfersResult.error ?? "Unknown error"}`;

    trace.log({
      ok: true,
      walletCount: wallets.length,
      transferCount: transfers.length,
      apiKeyCount: apiKeys.length,
      hasAggregate: Boolean(aggregate),
    });

    return (
      <div className="flex h-full min-h-0 w-full flex-col">
        <PaymentsWorkspace
          apiBaseUrl={apiBaseUrl}
          apiKeys={apiKeys}
          wallets={wallets}
          walletsError={walletsError}
          aggregate={aggregate}
          aggregateError={aggregateError}
          issuedTokenSymbolsByMint={issuedTokenSymbolsByMint}
          transfers={transfers}
          transfersError={transfersError}
        />
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
