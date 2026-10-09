import type { PaymentsDashboardWallet, PaymentWalletPolicy, PolicyProfileStatus } from "@sdp/types";
import type { SdpApiClient } from "@/lib/sdp-api";
import { fetchPaymentsWallets } from "../payments/payments-page.data";
import type { ApiKeyAuthoringExistingKey } from "./api-key-authoring";

export type WalletControlStatus = "default_allow" | Exclude<PolicyProfileStatus, "archived">;

/** A wallet with its wallet-control baseline, read from the Policies module. */
export interface ApiKeyAuthoringWallet extends PaymentsDashboardWallet {
  controlStatus: WalletControlStatus;
  activeRevisionNumber: number | null;
}

/**
 * The wallets an API key can be bound to. Wallet controls exist only when the deployment
 * runs Policies; without it there is no baseline to show, so none is invented.
 */
export type ApiKeyAuthoringWallets =
  | { policiesInReleaseChannel: true; wallets: ApiKeyAuthoringWallet[] }
  | { policiesInReleaseChannel: false; wallets: PaymentsDashboardWallet[] };

async function fetchWalletControlBaseline(
  client: SdpApiClient,
  wallet: PaymentsDashboardWallet
): Promise<ApiKeyAuthoringWallet> {
  const { policy } = await client.fetch<{ policy: PaymentWalletPolicy }>(
    `/v1/payments/wallets/${encodeURIComponent(wallet.id)}/policies`
  );
  const profile = policy.controlProfile;
  return {
    ...wallet,
    controlStatus:
      profile?.status === "archived" ? "disabled" : (profile?.status ?? "default_allow"),
    activeRevisionNumber: profile?.revisionNumber ?? null,
  };
}

/**
 * Loads the wallets an API key can be bound to. Without the Policies module the
 * per-wallet policy read is skipped rather than failing on its 403.
 */
export async function fetchApiKeyAuthoringWallets(
  client: SdpApiClient,
  { policiesInReleaseChannel }: { policiesInReleaseChannel: boolean }
): Promise<ApiKeyAuthoringWallets> {
  const result = await fetchPaymentsWallets(client.request, { includeBalances: false });
  if (!result.ok) {
    throw new Error(result.error ?? "Unable to load wallets");
  }
  const wallets = result.data ?? [];
  if (!policiesInReleaseChannel) {
    return { policiesInReleaseChannel: false, wallets };
  }
  return {
    policiesInReleaseChannel: true,
    wallets: await Promise.all(wallets.map((wallet) => fetchWalletControlBaseline(client, wallet))),
  };
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
