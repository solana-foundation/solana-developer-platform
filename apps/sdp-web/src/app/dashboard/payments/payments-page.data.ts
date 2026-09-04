import type {
  CustodyProvider,
  CustodyWalletAggregate,
  PaymentsDashboardWallet,
  PaymentTransferSummary,
} from "@sdp/types";
import { z } from "zod";
import type { SdpApiClient } from "@/lib/sdp-api";
import { parsePaymentApiErrorText } from "./payment-api-errors";

const paymentTransferRequiredFieldsSchema = z.object({
  custodyWalletId: z.string().min(1).regex(/^\S+$/).nullable(),
  providerWalletId: z.string().min(1).regex(/^\S+$/),
  rampsMemo: z.record(z.string(), z.string()),
});

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
  /** Issued-token id (`tok_…`). Null when the listing omits it. */
  id: string | null;
  mintAddress: string;
  symbol: string;
  imageUrl: string | null;
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
  const requiredFields = paymentTransferRequiredFieldsSchema.safeParse(transfer);
  if (!requiredFields.success) {
    throw new Error("Malformed transfer response: required fields are missing or invalid");
  }

  const {
    id,
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
  const { custodyWalletId, providerWalletId, rampsMemo } = requiredFields.data;

  return Object.fromEntries(
    Object.entries({
      id: id ?? "",
      custodyWalletId,
      providerWalletId,
      status: status ?? "pending",
      signature: signature ?? null,
      type,
      direction,
      source,
      destination,
      token,
      amount,
      memo,
      rampsMemo,
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
    custodyWalletId?: string;
    includeObserved?: boolean;
  } = {}
): Promise<FetchResult<PaymentTransferSummary[]>> {
  try {
    const query = new URLSearchParams({
      page: "1",
      pageSize: String(pageSize),
      ...(options.custodyWalletId ? { custodyWalletId: options.custodyWalletId } : {}),
      includeObserved: String(options.includeObserved ?? false),
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
  const byKey = new Map<string, PaymentTransferSummary>();
  for (const transfer of transfers) {
    const key = transfer.signature?.trim() || transfer.id;
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing || (existing.custodyWalletId === null && transfer.custodyWalletId !== null)) {
      byKey.set(key, transfer);
    }
  }
  return [...byKey.values()];
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

  const observedAddresses = new Set<string>();
  const [persistedResult, settledTransfers] = await Promise.all([
    fetchPaymentTransfers(request, pageSize),
    Promise.allSettled(
      (walletsResult.data ?? []).map((wallet) => {
        const address = wallet.publicKey.trim();
        const includeObserved = address.length > 0 && !observedAddresses.has(address);
        if (includeObserved) observedAddresses.add(address);
        return fetchPaymentTransfers(request, pageSize, {
          custodyWalletId: wallet.id,
          includeObserved,
        });
      })
    ),
  ]);

  const mergedTransfers: PaymentTransferSummary[] = persistedResult.data ?? [];
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
    if (persistedResult.ok || !lastError) {
      return persistedResult;
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

/**
 * Fetches the org's issued tokens keyed by mint address — the lookup shape
 * `resolveTokenByMint` takes. A failed fetch degrades to an empty map so
 * balance surfaces still render with well-known symbols.
 *
 * @param request - The authenticated SDP API request function.
 * @returns The issued tokens keyed by mint address.
 */
export async function fetchIssuedTokensByMint(
  request: SdpApiClient["request"]
): Promise<Record<string, PaymentsIssuedTokenSymbol>> {
  const result = await fetchPaymentsIssuedTokenSymbols(request);
  return Object.fromEntries((result.data ?? []).map((token) => [token.mintAddress, token]));
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
              id?: string;
              mintAddress?: string | null;
              symbol?: string;
              imageUrl?: string | null;
            }>
          | {
              tokens?: Array<{
                id?: string;
                mintAddress?: string | null;
                symbol?: string;
                imageUrl?: string | null;
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
              id?: string;
              mintAddress: string;
              symbol?: string;
              imageUrl?: string | null;
            } => typeof token?.mintAddress === "string" && token.mintAddress.length > 0
          )
          .map((token) => ({
            id: typeof token.id === "string" && token.id.length > 0 ? token.id : null,
            mintAddress: token.mintAddress,
            symbol: token.symbol?.trim() || token.mintAddress,
            imageUrl:
              typeof token.imageUrl === "string" && token.imageUrl.trim().length > 0
                ? token.imageUrl
                : null,
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
