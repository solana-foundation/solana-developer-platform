import type { ListCounterpartiesResponse, PaymentsDashboardWalletsEnvelope } from "@sdp/types";
import { resolveTransferTokenLabel } from "@/app/dashboard/payments/payments-overview.utils";

export interface TransactionFilterOptions {
  wallets: Array<{ id: string; label: string }>;
  counterparties: Array<{ id: string; label: string }>;
  /**
   * Held tokens, keyed by mint.
   *
   * The asset filter matches `pt.token` exactly and that column stores a mint, so
   * the value has to be an address — but nobody should have to read or type one.
   * The label carries the symbol; the id carries the mint.
   */
  assets: Array<{ id: string; label: string }>;
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
  const [walletsResponse, firstCounterpartiesResponse, aggregateResponse] = await Promise.all([
    request("/api/dashboard/wallets?view=summary", { cache: "no-store" }),
    request(`/api/dashboard/counterparty?page=1&pageSize=${COUNTERPARTY_PAGE_SIZE}`, {
      cache: "no-store",
    }),
    // Assets are a convenience, not a requirement, so this one degrades on its
    // own. Left in the shared Promise.all it would reject the whole thing on a
    // transport error and every select — wallets and counterparties included —
    // would render empty. Checking `.ok` afterwards only covers HTTP errors,
    // which are the case that never reaches this handler.
    request("/api/dashboard/wallets/aggregate", { cache: "no-store" }).catch(() => null),
  ]);
  const aggregateBody = aggregateResponse?.ok
    ? ((await aggregateResponse.json().catch(() => null)) as {
        data?: { aggregate?: { balances?: Array<{ mint: string; token: string }> } };
      } | null)
    : null;

  // `balance.token` is not a symbol — the aggregate returns the mint there for
  // well-known tokens, which is why the home card runs it through the same
  // resolver rather than rendering it directly. Skipping that step put a
  // 44-character address in the filter.
  const balances = aggregateBody?.data?.aggregate?.balances ?? [];
  const symbolsByMint = Object.fromEntries(
    balances.filter((balance) => balance?.mint).map((balance) => [balance.mint, balance.token])
  );
  const assetOptions = balances
    .filter((balance) => Boolean(balance?.mint))
    .map((balance) => ({
      id: balance.mint,
      label: resolveTransferTokenLabel(balance.mint, symbolsByMint) ?? balance.mint,
    }));

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
    assets: uniqueOptions(assetOptions),
  };
}
