import type {
  CustodyProvider,
  CustodyWalletAggregate,
  PaymentsDashboardWallet,
  PaymentTransferSummary,
} from "@sdp/types";
import type { SdpApiClient } from "@/lib/sdp-api";
import { parsePaymentApiErrorText } from "./payment-api-errors";

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
        error: parsePaymentApiErrorText(body),
      };
    }

    const json = (await response.json()) as {
      data?: {
        wallets?: Array<{
          id?: string;
          walletId?: string;
          publicKey?: string;
          label?: string | null;
          provider?: string;
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
        ...(wallet.provider ? { provider: wallet.provider as CustodyProvider } : {}),
        ...(Array.isArray(wallet.balances) ? { balances: wallet.balances } : {}),
      }));

    return { ok: true, data: wallets };
  } catch (error) {
    return {
      ok: false,
      ...(error instanceof Error ? { error: error.message } : {}),
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
        error: parsePaymentApiErrorText(body),
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
      };
    }

    return { ok: true, data: json.data.aggregate };
  } catch (error) {
    return {
      ok: false,
      ...(error instanceof Error ? { error: error.message } : {}),
    };
  }
}

function normalizePaymentTransfer(
  transfer: Partial<PaymentTransferSummary>
): PaymentTransferSummary {
  const {
    id,
    walletId,
    status,
    signature,
    type,
    direction,
    source,
    destination,
    token,
    amount,
    memo,
    provider,
    counterpartyId,
    counterpartyDisplayName,
    providerReference,
    deliveryMode,
    fiatCurrency,
    fiatAmount,
    settlement,
    moneygram,
    createdAt,
    updatedAt,
  } = transfer;

  return Object.fromEntries(
    Object.entries({
      id: id ?? "",
      walletId,
      status: status ?? "pending",
      signature: signature ?? null,
      type,
      direction,
      source,
      destination,
      token,
      amount,
      memo,
      provider,
      counterpartyId,
      counterpartyDisplayName,
      providerReference,
      deliveryMode,
      fiatCurrency,
      fiatAmount,
      settlement,
      moneygram,
      createdAt,
      updatedAt,
    }).filter(([, value]) => value !== undefined)
  ) as unknown as PaymentTransferSummary;
}

export async function fetchPaymentTransfers(
  request: SdpApiClient["request"],
  pageSize = 20,
  options: {
    walletId?: string;
    includeObserved?: boolean;
  } = {}
): Promise<FetchResult<PaymentTransferSummary[]>> {
  try {
    const query = new URLSearchParams({
      page: "1",
      pageSize: String(pageSize),
      ...(options.walletId ? { wallet: options.walletId } : {}),
      ...(options.includeObserved === false ? { includeObserved: "false" } : {}),
    }).toString();
    const response = await request(`/v1/payments/transfers?${query}`);
    if (!response.ok) {
      const body = await response.text();
      return {
        ok: false,
        status: response.status,
        error: parsePaymentApiErrorText(body),
      };
    }

    const json = (await response.json()) as {
      data?: Array<Partial<PaymentTransferSummary>>;
    };

    const transfers = (json?.data ?? [])
      .filter((transfer) => typeof transfer.id === "string")
      .map(normalizePaymentTransfer);

    return { ok: true, data: transfers };
  } catch (error) {
    return {
      ok: false,
      ...(error instanceof Error ? { error: error.message } : {}),
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
  return fetchDashboardPaymentTransfersForWallets(request, walletsResult, pageSize);
}

export async function fetchDashboardPaymentTransfersForWallets(
  request: SdpApiClient["request"],
  walletsResult: FetchResult<PaymentsDashboardWallet[]>,
  pageSize = 20
): Promise<FetchResult<PaymentTransferSummary[]>> {
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
      lastError = result.reason instanceof Error ? result.reason.message : undefined;
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
    const tokens: PaymentsIssuedTokenSymbol[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await request(
        `/v1/issuance/tokens?${new URLSearchParams({
          page: String(page),
          pageSize: String(pageSize),
        }).toString()}`
      );
      if (!response.ok) {
        const body = await response.text();
        return {
          ok: false,
          status: response.status,
          error: parsePaymentApiErrorText(body),
        };
      }

      const json = (await response.json()) as {
        data?:
          | Array<{
              mintAddress?: string | null;
              symbol?: string;
            }>
          | {
              tokens?: Array<{
                mintAddress?: string | null;
                symbol?: string;
              }>;
            };
        meta?: {
          hasMore?: boolean;
        };
      };

      const pageTokens = Array.isArray(json.data) ? json.data : (json.data?.tokens ?? []);
      tokens.push(
        ...pageTokens
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
          }))
      );

      hasMore = json.meta?.hasMore === true;
      page += 1;
    }

    return { ok: true, data: tokens };
  } catch (error) {
    return {
      ok: false,
      ...(error instanceof Error ? { error: error.message } : {}),
    };
  }
}
