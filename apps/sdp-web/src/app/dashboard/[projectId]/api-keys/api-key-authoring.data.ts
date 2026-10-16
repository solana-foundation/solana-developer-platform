import type { PaymentsDashboardWallet } from "@sdp/types";
import type { SdpApiClient } from "@/lib/sdp-api";
import { fetchPaymentsWallets } from "../payments/payments-page.data";
import type { ApiKeyAuthoringExistingKey } from "./api-key-authoring";

/** The wallets an API key can be bound to. */
export async function fetchApiKeyAuthoringWallets(
  client: SdpApiClient
): Promise<PaymentsDashboardWallet[]> {
  const result = await fetchPaymentsWallets(client.request, { includeBalances: false });
  if (!result.ok) {
    throw new Error(result.error ?? "Unable to load wallets");
  }
  return result.data ?? [];
}

export async function fetchApiKeyForAuthoring(
  client: SdpApiClient,
  keyId: string
): Promise<ApiKeyAuthoringExistingKey | null> {
  const response = await client.request(`/v1/api-keys/${encodeURIComponent(keyId)}`);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Unable to load API key (${response.status})`);
  }
  const body = (await response.json()) as { data?: ApiKeyAuthoringExistingKey };
  return body.data ?? null;
}
