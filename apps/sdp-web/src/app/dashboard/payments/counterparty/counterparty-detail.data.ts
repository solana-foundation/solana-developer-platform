import type {
  Counterparty,
  CounterpartyAccount,
  CounterpartyResponse,
  ListCounterpartyAccountsResponse,
} from "@sdp/types";
import type { SdpApiClient } from "@/lib/sdp-api";

export async function fetchCounterpartyDetail(
  request: SdpApiClient["request"],
  counterpartyId: string
): Promise<{ counterparty: Counterparty | null; accounts: CounterpartyAccount[] }> {
  const encoded = encodeURIComponent(counterpartyId);
  const [counterpartyRes, accountsRes] = await Promise.all([
    request(`/v1/counterparties/${encoded}`),
    request(`/v1/counterparties/${encoded}/accounts?pageSize=100`),
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

  return { counterparty, accounts };
}
