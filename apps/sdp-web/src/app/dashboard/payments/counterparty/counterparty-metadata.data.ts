import type { CounterpartyFieldOptions } from "@sdp/types";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { dashboardFetch } from "@/lib/dashboard-fetch";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

export const COUNTERPARTY_METADATA_KEY = "counterparty-field-options";

export async function fetchCounterpartyMetadata(t: Translate): Promise<CounterpartyFieldOptions> {
  const result = await dashboardFetch<{ data: { fields: CounterpartyFieldOptions } }>(
    "/api/dashboard/counterparty/metadata"
  );
  if (!result.ok) {
    throw new Error(result.error);
  }
  const fields = result.data?.data?.fields;
  if (!fields) {
    throw new Error(t("DashboardPayments.counterparty.metadataMissing"));
  }
  return fields;
}
