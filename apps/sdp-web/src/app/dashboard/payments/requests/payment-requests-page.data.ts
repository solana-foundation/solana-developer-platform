import type {
  CryptoAssetSymbol,
  ListPaymentRequestsResponse,
  PaginatedResponse,
  PaymentRequest,
  PaymentsDashboardWallet,
} from "@sdp/types";
import type { SdpApiClient } from "@/lib/sdp-api";

export const PAYMENT_REQUESTS_PAGE_SIZE = 100;

const SUPPORTED_REQUEST_TOKENS = [
  "SOL",
  "USDC",
  "USDT",
] as const satisfies readonly CryptoAssetSymbol[];

export interface PaymentRequestTokenOption {
  mintAddress: string;
  symbol: string;
}

export function deriveTokenOptions(
  wallets: PaymentsDashboardWallet[]
): PaymentRequestTokenOption[] {
  const supported = new Set<string>(SUPPORTED_REQUEST_TOKENS);
  const symbolByMint = new Map<string, string>();
  for (const wallet of wallets) {
    if (!wallet.balances) {
      continue;
    }
    for (const balance of wallet.balances) {
      if (supported.has(balance.token) && !symbolByMint.has(balance.mint)) {
        symbolByMint.set(balance.mint, balance.token);
      }
    }
  }
  return [...symbolByMint].map(([mintAddress, symbol]) => ({ mintAddress, symbol }));
}

export async function fetchPaymentRequests(
  request: SdpApiClient["request"]
): Promise<PaginatedResponse<PaymentRequest>> {
  try {
    const response = await request(`/v1/payments/requests?pageSize=${PAYMENT_REQUESTS_PAGE_SIZE}`);
    if (!response.ok) {
      return { ok: false, data: [], total: 0, error: await response.text() };
    }
    const json = (await response.json()) as { data: ListPaymentRequestsResponse };
    return { ok: true, data: json.data.paymentRequests, total: json.data.total };
  } catch (error) {
    return {
      ok: false,
      data: [],
      total: 0,
      error: error instanceof Error ? error.message : "Unable to load payment requests",
    };
  }
}
