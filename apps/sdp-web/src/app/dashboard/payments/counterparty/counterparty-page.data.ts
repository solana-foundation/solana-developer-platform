import type {
  Counterparty,
  CounterpartyAccountSummary,
  CounterpartyResponse,
  ListCounterpartiesResponse,
  ListProjectCounterpartyAccountsResponse,
  PaginatedResponse,
} from "@sdp/types";
import type { SdpApiClient } from "@/lib/sdp-api";

export const COUNTERPARTY_PAGE_SIZE = 10;

export async function fetchCounterparties(
  request: SdpApiClient["request"],
  options: { page?: number; pageSize?: number } = {}
): Promise<PaginatedResponse<Counterparty>> {
  const page = options.page ?? 1;
  const pageSize = options.pageSize ?? COUNTERPARTY_PAGE_SIZE;
  try {
    const response = await request(
      `/v1/counterparties?${new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      }).toString()}`
    );
    if (!response.ok) {
      const body = await response.text();
      return { ok: false, data: [], total: 0, error: body };
    }
    const json = (await response.json()) as { data?: ListCounterpartiesResponse };
    return {
      ok: true,
      data: json.data?.counterparties ?? [],
      total: json.data?.total ?? 0,
    };
  } catch (error) {
    return {
      ok: false,
      data: [],
      total: 0,
      ...(error instanceof Error ? { error: error.message } : {}),
    };
  }
}

export async function fetchCounterparty(
  request: SdpApiClient["request"],
  counterpartyId: string
): Promise<Counterparty | null> {
  try {
    const response = await request(`/v1/counterparties/${encodeURIComponent(counterpartyId)}`);
    if (!response.ok) {
      return null;
    }

    const json = (await response.json()) as { data?: CounterpartyResponse };
    return json.data?.counterparty ?? null;
  } catch {
    return null;
  }
}

/** The most contacts the Contact list loads for local search and filtering. */
export const CONTACT_DIRECTORY_CAP = 500;
const DIRECTORY_PAGE_SIZE = 100;

/**
 * Every counterparty up to `cap`, read in pages of 100. The list API has no search or type
 * filter, so the Contact list loads the directory once and searches it locally.
 *
 * @param request - Authenticated API request function.
 * @param cap - Most rows to read.
 * @returns The loaded counterparties and the directory's full total.
 */
export async function fetchCounterpartyDirectory(
  request: SdpApiClient["request"],
  cap = CONTACT_DIRECTORY_CAP
): Promise<PaginatedResponse<Counterparty>> {
  const first = await fetchCounterparties(request, { page: 1, pageSize: DIRECTORY_PAGE_SIZE });
  if (!first.ok) return first;
  const target = Math.min(first.total, cap);
  const pages = Math.ceil(target / DIRECTORY_PAGE_SIZE);
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, pages - 1) }, (_, index) =>
      fetchCounterparties(request, { page: index + 2, pageSize: DIRECTORY_PAGE_SIZE })
    )
  );
  const failed = rest.find((result) => !result.ok);
  if (failed) return failed;
  return {
    ok: true,
    data: [first, ...rest].flatMap((result) => result.data).slice(0, cap),
    total: first.total,
  };
}

/**
 * The project's saved Solana addresses across every counterparty, up to `cap`, for the Contact
 * list's Address column and address search. `total` is the project's full account count, so
 * the list can say when the cap left some contacts' addresses unloaded.
 *
 * @param request - Authenticated API request function.
 * @param cap - Most accounts to read.
 * @returns The accounts and the full total, or what was read when they could not all be read.
 */
export async function fetchProjectCounterpartyAccounts(
  request: SdpApiClient["request"],
  cap = CONTACT_DIRECTORY_CAP * 2
): Promise<{ ok: boolean; data: CounterpartyAccountSummary[]; total: number }> {
  const accounts: CounterpartyAccountSummary[] = [];
  let total = 0;
  for (let page = 1; accounts.length < cap; page += 1) {
    try {
      const response = await request(
        `/v1/counterparties/accounts?page=${page}&pageSize=${DIRECTORY_PAGE_SIZE}`
      );
      if (!response.ok) return { ok: false, data: accounts, total };
      const json = (await response.json()) as { data?: ListProjectCounterpartyAccountsResponse };
      const rows = json.data?.accounts ?? [];
      total = json.data?.total ?? total;
      accounts.push(...rows);
      if (rows.length < DIRECTORY_PAGE_SIZE || accounts.length >= total) break;
    } catch {
      return { ok: false, data: accounts, total };
    }
  }
  return { ok: true, data: accounts.slice(0, cap), total: Math.max(total, accounts.length) };
}
