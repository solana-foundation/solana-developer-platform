import { type SdpApiClient, createSdpApiClient } from "@/lib/sdp-api";
import { auth } from "@clerk/nextjs/server";
import type {
  CustodyWalletAggregate,
  PaymentTransferSummary,
  PaymentsDashboardWallet,
} from "@sdp/types";
import { redirect } from "next/navigation";
import { fetchActiveApiKeys, resolvePlaygroundApiBaseUrl } from "../playground-api-data";
import { PaymentsWorkspace } from "./payments-workspace";

interface FetchResult<T> {
  ok: boolean;
  status?: number;
  data?: T;
  error?: string;
}

function parseErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string };
      message?: string;
    };
    return parsed?.error?.message ?? parsed?.message ?? body;
  } catch {
    return body;
  }
}

async function fetchPaymentsWallets(
  request: SdpApiClient["request"]
): Promise<FetchResult<PaymentsDashboardWallet[]>> {
  try {
    const query = new URLSearchParams({
      includeAllProviders: "true",
      includeBalances: "true",
    }).toString();
    const response = await request(`/v1/wallets?${query}`);
    if (!response.ok) {
      const body = await response.text();
      return {
        ok: false,
        status: response.status,
        error: parseErrorMessage(body),
      };
    }

    const json = (await response.json()) as {
      data?: {
        wallets?: Array<{
          id?: string;
          walletId?: string;
          publicKey?: string;
          label?: string | null;
          balances?: PaymentsDashboardWallet["balances"];
        }>;
      };
    };

    type WalletSummary = NonNullable<NonNullable<typeof json.data>["wallets"]>[number];
    type ValidWalletSummary = WalletSummary & {
      id: string;
      walletId: string;
      publicKey: string;
    };

    const wallets = (json?.data?.wallets ?? [])
      .filter(
        (wallet): wallet is ValidWalletSummary =>
          typeof wallet?.id === "string" &&
          typeof wallet.walletId === "string" &&
          typeof wallet.publicKey === "string"
      )
      .map((wallet) => ({
        id: wallet.id,
        walletId: wallet.walletId,
        publicKey: wallet.publicKey,
        label: wallet.label ?? null,
        ...(Array.isArray(wallet.balances) ? { balances: wallet.balances } : {}),
      }));

    return { ok: true, data: wallets };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unable to load wallets",
    };
  }
}

async function fetchPaymentsAggregate(
  request: SdpApiClient["request"]
): Promise<FetchResult<CustodyWalletAggregate>> {
  try {
    const query = new URLSearchParams({ includeAllProviders: "true" }).toString();
    const response = await request(`/v1/wallets/aggregate?${query}`);
    if (!response.ok) {
      const body = await response.text();
      return {
        ok: false,
        status: response.status,
        error: parseErrorMessage(body),
      };
    }

    const json = (await response.json()) as {
      data?: {
        aggregate?: CustodyWalletAggregate;
      };
    };

    if (!json?.data?.aggregate) {
      return {
        ok: false,
        error: "Aggregate wallet response did not include aggregate data",
      };
    }

    return { ok: true, data: json.data.aggregate };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unable to load aggregate balances",
    };
  }
}

async function fetchPaymentTransfers(
  request: SdpApiClient["request"]
): Promise<FetchResult<PaymentTransferSummary[]>> {
  try {
    const query = new URLSearchParams({
      page: "1",
      pageSize: "20",
    }).toString();
    const response = await request(`/v1/payments/transfers?${query}`);
    if (!response.ok) {
      const body = await response.text();
      return {
        ok: false,
        status: response.status,
        error: parseErrorMessage(body),
      };
    }

    const json = (await response.json()) as {
      data?: Array<{
        id?: string;
        status?: string;
        signature?: string | null;
        type?: string;
        direction?: string;
        source?: string;
        destination?: string;
        token?: string;
        amount?: string;
        memo?: string;
        createdAt?: string;
        updatedAt?: string;
      }>;
    };

    const transfers = (json?.data ?? [])
      .filter((transfer): transfer is NonNullable<typeof transfer> => Boolean(transfer?.id))
      .map((transfer) => ({
        id: transfer.id ?? "",
        status: transfer.status ?? "pending",
        signature: transfer.signature ?? null,
        ...(transfer.type ? { type: transfer.type } : {}),
        ...(transfer.direction ? { direction: transfer.direction } : {}),
        ...(transfer.source ? { source: transfer.source } : {}),
        ...(transfer.destination ? { destination: transfer.destination } : {}),
        ...(transfer.token ? { token: transfer.token } : {}),
        ...(transfer.amount ? { amount: transfer.amount } : {}),
        ...(transfer.memo ? { memo: transfer.memo } : {}),
        ...(transfer.createdAt ? { createdAt: transfer.createdAt } : {}),
        ...(transfer.updatedAt ? { updatedAt: transfer.updatedAt } : {}),
      }));

    return { ok: true, data: transfers };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unable to load transfers",
    };
  }
}

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
    <div className="flex h-full min-h-0 w-full flex-col">
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
    </div>
  );
}
