import type { ListCounterpartiesResponse, PaymentsDashboardWalletsEnvelope } from "@sdp/types";

export interface TransactionFilterOptions {
  wallets: Array<{ id: string; label: string }>;
  counterparties: Array<{ id: string; label: string }>;
}

const COUNTERPARTY_PAGE_SIZE = 100;
const COUNTERPARTY_PAGE_CONCURRENCY = 4;

type FilterOptionsRequest = (input: string, init?: RequestInit) => Promise<Response>;

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error("Transaction filter options could not be loaded");
  }
  return (await response.json()) as T;
}

function uniqueOptions(options: Array<{ id: string; label: string }>) {
  return [...new Map(options.map((option) => [option.id, option])).values()];
}

export async function fetchTransactionFilterOptions(
  request: FilterOptionsRequest = fetch
): Promise<TransactionFilterOptions> {
  const [walletsResponse, firstCounterpartiesResponse] = await Promise.all([
    request("/api/dashboard/wallets?view=summary", { cache: "no-store" }),
    request(`/api/dashboard/counterparty?page=1&pageSize=${COUNTERPARTY_PAGE_SIZE}`, {
      cache: "no-store",
    }),
  ]);
  const [walletsBody, firstCounterpartiesBody] = await Promise.all([
    readJson<PaymentsDashboardWalletsEnvelope>(walletsResponse),
    readJson<{ data?: ListCounterpartiesResponse }>(firstCounterpartiesResponse),
  ]);
  const firstPage = firstCounterpartiesBody.data;
  const pageSize = Math.max(1, firstPage?.pageSize ?? COUNTERPARTY_PAGE_SIZE);
  const pageCount = Math.ceil((firstPage?.total ?? 0) / pageSize);
  const counterparties = [...(firstPage?.counterparties ?? [])];

  for (let page = 2; page <= pageCount; page += COUNTERPARTY_PAGE_CONCURRENCY) {
    const pages = Array.from(
      { length: Math.min(COUNTERPARTY_PAGE_CONCURRENCY, pageCount - page + 1) },
      (_, index) => page + index
    );
    const responses = await Promise.all(
      pages.map((pageNumber) =>
        request(
          `/api/dashboard/counterparty?page=${pageNumber}&pageSize=${COUNTERPARTY_PAGE_SIZE}`,
          { cache: "no-store" }
        )
      )
    );
    const bodies = await Promise.all(
      responses.map((response) => readJson<{ data?: ListCounterpartiesResponse }>(response))
    );
    for (const body of bodies) {
      counterparties.push(...(body.data?.counterparties ?? []));
    }
  }

  return {
    wallets: uniqueOptions(
      (walletsBody.data?.wallets ?? []).map((wallet) => ({
        id: wallet.walletId,
        label: wallet.label?.trim() || wallet.publicKey,
      }))
    ),
    counterparties: uniqueOptions(
      counterparties.map((counterparty) => ({
        id: counterparty.id,
        label: counterparty.displayName,
      }))
    ),
  };
}
