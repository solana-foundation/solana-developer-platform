import type { Counterparty, ListCounterpartiesResponse } from "@sdp/types/counterparties";
import type { PaginatedResponse } from "@sdp/types/pagination";
import type { SdpApiClient } from "@/lib/sdp-api";

const COUNTERPARTY_PAGE_SIZE = 10;

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
