import type {
  CustodyWalletAggregate,
  PaymentsDashboardWallet,
  PaymentTransferSummary,
} from "@sdp/types";
import type { SdpApiClient } from "@/lib/sdp-api";

export interface FetchResult<T> {
  ok: boolean;
  status?: number;
  data?: T;
  error?: string;
}

interface FetchPaymentsWalletsOptions {
  includeBalances?: boolean;
  view?: "default" | "summary";
}

export interface PaymentsIssuedTokenSymbol {
  mintAddress: string;
  symbol: string;
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

export async function fetchPaymentsWallets(
  request: SdpApiClient["request"],
  options: FetchPaymentsWalletsOptions = {}
): Promise<FetchResult<PaymentsDashboardWallet[]>> {
  try {
    const query = new URLSearchParams({
      includeAllProviders: "true",
      ...(options.view === "summary" ? { view: "summary" } : {}),
      ...(options.includeBalances ? { includeBalances: "true" } : {}),
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

export async function fetchPaymentsAggregate(
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

export async function fetchPaymentTransfers(
  request: SdpApiClient["request"],
  pageSize = 20,
  options: {
    walletId?: string;
  } = {}
): Promise<FetchResult<PaymentTransferSummary[]>> {
  try {
    const query = new URLSearchParams({
      page: "1",
      pageSize: String(pageSize),
      ...(options.walletId ? { wallet: options.walletId } : {}),
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

function dedupeTransfers(transfers: PaymentTransferSummary[]): PaymentTransferSummary[] {
  const seen = new Set<string>();

  return transfers.filter((transfer) => {
    const key = transfer.signature?.trim() || transfer.id;
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export async function fetchDashboardPaymentTransfers(
  request: SdpApiClient["request"],
  pageSize = 20
): Promise<FetchResult<PaymentTransferSummary[]>> {
  const walletsResult = await fetchPaymentsWallets(request, { view: "summary" });

  if (!walletsResult.ok || (walletsResult.data?.length ?? 0) === 0) {
    return fetchPaymentTransfers(request, pageSize);
  }

  const settledTransfers = await Promise.allSettled(
    (walletsResult.data ?? []).map((wallet) =>
      fetchPaymentTransfers(request, pageSize, { walletId: wallet.walletId })
    )
  );

  const mergedTransfers: PaymentTransferSummary[] = [];
  let lastError: string | undefined;

  for (const result of settledTransfers) {
    if (result.status !== "fulfilled") {
      lastError =
        result.reason instanceof Error ? result.reason.message : "Unable to load transfers";
      continue;
    }

    if (!result.value.ok) {
      lastError = result.value.error;
      continue;
    }

    mergedTransfers.push(...(result.value.data ?? []));
  }

  if (mergedTransfers.length === 0) {
    const fallback = await fetchPaymentTransfers(request, pageSize);
    if (fallback.ok || !lastError) {
      return fallback;
    }

    return {
      ok: false,
      error: lastError,
    };
  }

  return {
    ok: true,
    data: dedupeTransfers(mergedTransfers)
      .sort((left, right) => {
        const leftTimestamp = left.createdAt ? new Date(left.createdAt).getTime() : 0;
        const rightTimestamp = right.createdAt ? new Date(right.createdAt).getTime() : 0;
        return rightTimestamp - leftTimestamp;
      })
      .slice(0, pageSize),
  };
}

export async function fetchPaymentsIssuedTokenSymbols(
  request: SdpApiClient["request"],
  pageSize = 100
): Promise<FetchResult<PaymentsIssuedTokenSymbol[]>> {
  try {
    const response = await request(
      `/v1/issuance/tokens?${new URLSearchParams({
        page: "1",
        pageSize: String(pageSize),
      }).toString()}`
    );
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
        mintAddress?: string | null;
        symbol?: string;
      }>;
    };

    const tokens = (json?.data ?? [])
      .filter(
        (
          token
        ): token is {
          mintAddress: string;
          symbol?: string;
        } => typeof token?.mintAddress === "string" && token.mintAddress.length > 0
      )
      .map((token) => ({
        mintAddress: token.mintAddress,
        symbol: token.symbol?.trim() || token.mintAddress,
      }));

    return { ok: true, data: tokens };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unable to load issued token symbols",
    };
  }
}
