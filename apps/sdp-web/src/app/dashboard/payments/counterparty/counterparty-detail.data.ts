import type {
  Counterparty,
  CounterpartyAccount,
  CounterpartyResponse,
  ListCounterpartyAccountsResponse,
  PaymentTransferStatus,
  PaymentTransferSummary,
} from "@sdp/types";
import type { SdpApiClient } from "@/lib/sdp-api";

const COUNTERPARTY_TRANSFERS_PAGE_SIZE = 50;

export async function fetchCounterpartyDetail(
  request: SdpApiClient["request"],
  counterpartyId: string
): Promise<{
  counterparty: Counterparty | null;
  accounts: CounterpartyAccount[];
  /** How many addresses the contact has saved; more than `accounts` when the page cut it. */
  accountsTotal: number;
  /** True when the addresses could not be read, so none loaded is not none saved. */
  accountsFailed: boolean;
  transfers: PaymentTransferSummary[];
  /** True when the transfers could not be read, so no transfers is not no payment history. */
  transfersFailed: boolean;
}> {
  const encoded = encodeURIComponent(counterpartyId);
  const [counterpartyRes, accountsRes, transfersRes] = await Promise.all([
    request(`/v1/counterparties/${encoded}`),
    request(`/v1/counterparties/${encoded}/accounts?pageSize=100`),
    request(
      `/v1/payments/transfers?counterpartyId=${encoded}&pageSize=${COUNTERPARTY_TRANSFERS_PAGE_SIZE}`
    ),
  ]);

  let counterparty: Counterparty | null = null;
  if (counterpartyRes.ok) {
    const json = (await counterpartyRes.json()) as { data?: CounterpartyResponse };
    counterparty = json.data?.counterparty ?? null;
  }

  let accounts: CounterpartyAccount[] = [];
  let accountsTotal = 0;
  if (accountsRes.ok) {
    const json = (await accountsRes.json()) as { data?: ListCounterpartyAccountsResponse };
    accounts = json.data?.accounts ?? [];
    accountsTotal = Math.max(json.data?.total ?? 0, accounts.length);
  }

  let transfers: PaymentTransferSummary[] = [];
  if (transfersRes.ok) {
    const json = (await transfersRes.json()) as { data?: PaymentTransferSummary[] };
    transfers = json.data ?? [];
  }

  return {
    counterparty,
    accounts,
    accountsTotal,
    accountsFailed: !accountsRes.ok,
    transfers,
    transfersFailed: !transfersRes.ok,
  };
}

/** The statuses a payout has settled in: what "Paid so far" and "Last paid" count. */
export const SETTLED_PAYOUT_STATUSES: readonly PaymentTransferStatus[] = [
  "completed",
  "confirmed",
  "finalized",
];

/** The most settled payouts a contact's page reads to total what it has been paid. */
export const COUNTERPARTY_PAYOUTS_CAP = 500;
const PAYOUTS_PAGE_SIZE = 100;

type PayoutsPage = { ok: boolean; data: PaymentTransferSummary[]; total: number };

async function fetchPayoutsPage(
  request: SdpApiClient["request"],
  counterpartyId: string,
  page: number
): Promise<PayoutsPage> {
  const query = new URLSearchParams({
    counterpartyId,
    direction: "outbound",
    status: SETTLED_PAYOUT_STATUSES.join(","),
    page: String(page),
    pageSize: String(PAYOUTS_PAGE_SIZE),
  });
  try {
    const response = await request(`/v1/payments/transfers?${query.toString()}`);
    if (!response.ok) return { ok: false, data: [], total: 0 };
    const json = (await response.json()) as {
      data?: PaymentTransferSummary[];
      meta?: { total?: number };
    };
    const data = json.data ?? [];
    return { ok: true, data, total: Math.max(json.meta?.total ?? 0, data.length) };
  } catch {
    return { ok: false, data: [], total: 0 };
  }
}

/**
 * A contact's settled outbound payouts, newest first, up to `cap`. The latest transfers alone
 * cannot total what a contact was paid: older payouts sit past them. `total` is the full payout
 * count, so the page can say when the cap left some unread.
 *
 * @param request - Authenticated API request function.
 * @param counterpartyId - The contact.
 * @param cap - Most payouts to read.
 * @returns The payouts read and the full count; `ok` is false when any page failed.
 */
export async function fetchCounterpartyPayouts(
  request: SdpApiClient["request"],
  counterpartyId: string,
  cap = COUNTERPARTY_PAYOUTS_CAP
): Promise<PayoutsPage> {
  const first = await fetchPayoutsPage(request, counterpartyId, 1);
  if (!first.ok) return first;
  const pages = Math.ceil(Math.min(first.total, cap) / PAYOUTS_PAGE_SIZE);
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, pages - 1) }, (_, index) =>
      fetchPayoutsPage(request, counterpartyId, index + 2)
    )
  );
  // Keep what was read up to the first failed page: the pages are newest first, so that is
  // still the latest payouts, and `total` says how many more there are.
  const failedAt = rest.findIndex((result) => !result.ok);
  const read = failedAt === -1 ? rest : rest.slice(0, failedAt);
  const seen = new Set<string>();
  const data = [first, ...read]
    .flatMap((result) => result.data)
    .filter((transfer) => {
      if (seen.has(transfer.id)) return false;
      seen.add(transfer.id);
      return true;
    })
    .slice(0, cap);
  return { ok: failedAt === -1, data, total: Math.max(first.total, data.length) };
}
