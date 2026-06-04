import type { CounterpartyFieldOptions } from "@sdp/types";
import { dashboardFetch } from "@/lib/dashboard-fetch";

export const COUNTERPARTY_METADATA_KEY = "counterparty-field-options";

export async function fetchCounterpartyMetadata(): Promise<CounterpartyFieldOptions> {
  const result = await dashboardFetch<{ data: { fields: CounterpartyFieldOptions } }>(
    "/api/dashboard/counterparty/metadata"
  );
  if (!result.ok) {
    throw new Error(result.error);
  }
  const fields = result.data?.data?.fields;
  if (!fields) {
    throw new Error("Counterparty metadata response was empty.");
  }
  return fields;
}
