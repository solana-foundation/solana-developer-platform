import type { PaymentsDashboardWallet, PaymentWalletPolicy, PolicyProfileStatus } from "@sdp/types";
import type { SdpApiClient } from "@/lib/sdp-api";
import { fetchPaymentsWallets } from "../payments/payments-page.data";
import type { ApiKeyAuthoringExistingKey } from "./api-key-authoring";

export type WalletControlStatus = "default_allow" | Exclude<PolicyProfileStatus, "archived">;

export interface ApiKeyAuthoringWallet extends PaymentsDashboardWallet {
  controlStatus: WalletControlStatus;
  activeRevisionNumber: number | null;
}

async function fetchWalletControlBaseline(
  client: SdpApiClient,
  wallet: PaymentsDashboardWallet
): Promise<ApiKeyAuthoringWallet> {
  const { policy } = await client.fetch<{ policy: PaymentWalletPolicy }>(
    `/v1/payments/wallets/${encodeURIComponent(wallet.walletId)}/policies`
  );
  const profile = policy.controlProfile;
  return {
    ...wallet,
    controlStatus:
      profile?.status === "archived" ? "disabled" : (profile?.status ?? "default_allow"),
    activeRevisionNumber: profile?.revisionNumber ?? null,
  };
}

export async function fetchApiKeyAuthoringWallets(
  client: SdpApiClient
): Promise<ApiKeyAuthoringWallet[]> {
  const result = await fetchPaymentsWallets(client.request, { includeBalances: false });
  if (!result.ok) {
    throw new Error(result.error ?? "Unable to load wallets");
  }
  return Promise.all(
    (result.data ?? []).map((wallet) => fetchWalletControlBaseline(client, wallet))
  );
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
