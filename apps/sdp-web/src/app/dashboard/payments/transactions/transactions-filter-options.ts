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

/**
 * Collapses the same asset arriving under more than one id.
 *
 * A held token comes back keyed by mint while a transfer of it may be recorded
 * under the bare symbol, so both resolve to one label and would otherwise show as
 * two identical-looking rows. First wins, which keeps the balance-derived mint
 * ahead of a symbol.
 */
function uniqueByLabel(options: Array<{ id: string; label: string }>) {
  const byLabel = new Map<string, { id: string; label: string }>();
  for (const option of options) {
    if (!byLabel.has(option.label)) {
      byLabel.set(option.label, option);
    }
  }
  return [...byLabel.values()];
}

/** One page is enough to name what an organization actually moves. */
const TRANSACTED_TOKEN_SAMPLE = 100;

export async function fetchTransactionFilterOptions(
  request: FilterOptionsRequest = fetch
): Promise<TransactionFilterOptions> {
  const [walletsResponse, firstCounterpartiesResponse, aggregateResponse, transfersResponse] =
    await Promise.all([
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
      // Held tokens are not the same set as filterable ones. An organization that
      // sent its whole balance away still has those transfers in the table, and
      // sourcing the options from balances alone left the filter empty on exactly
      // the ledger it was meant to narrow. Degrades on its own like the aggregate.
      request(`/api/dashboard/payments/transfers?page=1&pageSize=${TRANSACTED_TOKEN_SAMPLE}`, {
        cache: "no-store",
      }).catch(() => null),
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

  // `pt.token` holds a mint on some rows and a bare symbol on others, so the same
  // asset arrives under two ids. They are deduped by label rather than by id, and
  // either id filters correctly because the API expands a token to every form the
  // ledger stores it in.
  const transfersBody = transfersResponse?.ok
    ? ((await transfersResponse.json().catch(() => null)) as {
        data?: Array<{ token?: string | null }>;
      } | null)
    : null;
  // Array-checked rather than defaulted: an unexpected body would otherwise reach
  // .map as a non-array and throw, taking the whole filter bar down for a list
  // that is only ever supplementary.
  const transactedTokens = Array.isArray(transfersBody?.data) ? transfersBody.data : [];
  const transactedOptions = transactedTokens
    .map((transfer) => transfer?.token?.trim())
    .filter((token): token is string => Boolean(token))
    .map((token) => ({
      id: token,
      label: resolveTransferTokenLabel(token, symbolsByMint) ?? token,
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
    assets: uniqueByLabel([...assetOptions, ...transactedOptions]),
  };
}

/**
 * The asset options plus whatever the filter is currently pointed at.
 *
 * A filter can name a token the organization no longer holds, and a deep link
 * from a holding arrives with the mint already in the URL while these options are
 * still loading over SWR. Both cases need the current value to stay selectable,
 * and both used the mint as its own label — which put the 44-character address
 * back on screen that this filter exists to keep off it.
 *
 * @param value - The selected asset, a mint address, or undefined for "all".
 * @param options - Asset options resolved from the wallet aggregate.
 * @returns The options to render, with the current value present and named.
 */
export function assetFilterOptions(
  value: string | undefined,
  options: Array<{ id: string; label: string }>
): Array<{ id: string; label: string }> {
  const assets = [...options];
  if (value && !assets.some((asset) => asset.id === value)) {
    assets.unshift({ id: value, label: resolveTransferTokenLabel(value) ?? value });
  }
  return assets;
}
