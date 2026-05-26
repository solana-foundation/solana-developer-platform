import type { Counterparty, ListCounterpartiesResponse } from "@sdp/types";
import type { SdpApiClient } from "@/lib/sdp-api";

export async function fetchCounterparties(
  request: SdpApiClient["request"]
): Promise<{ ok: boolean; data: Counterparty[]; error?: string }> {
  try {
    const response = await request(
      `/v1/counterparties?${new URLSearchParams({ page: "1", pageSize: "100" }).toString()}`
    );
    if (!response.ok) {
      const body = await response.text();
      return { ok: false, data: [], error: body };
    }
    const json = (await response.json()) as { data?: ListCounterpartiesResponse };
    return { ok: true, data: json.data?.counterparties ?? [] };
  } catch (error) {
    return {
      ok: false,
      data: [],
      error: error instanceof Error ? error.message : "Unable to load counterparties",
    };
  }
}
