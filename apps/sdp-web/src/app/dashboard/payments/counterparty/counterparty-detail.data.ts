import type {
  Counterparty,
  CounterpartyAccount,
  CounterpartyResponse,
  ListCounterpartyAccountsResponse,
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
  transfers: PaymentTransferSummary[];
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
  if (accountsRes.ok) {
    const json = (await accountsRes.json()) as { data?: ListCounterpartyAccountsResponse };
    accounts = json.data?.accounts ?? [];
  }

  let transfers: PaymentTransferSummary[] = [];
  if (transfersRes.ok) {
    const json = (await transfersRes.json()) as { data?: PaymentTransferSummary[] };
    transfers = json.data ?? [];
  }

  return { counterparty, accounts, transfers };
}
