import type { CounterpartyProviderData } from "@sdp/types";
import type { CollectedFieldData } from "@sdp/types/ramp-requirements";
import { SdpPaymentsError } from "../../../errors";
import { hashString } from "../../../hash";

export interface LightsparkPayoutAccount {
  accountId: string;
  status: string;
}

export interface LightsparkPayoutAccountEntry extends LightsparkPayoutAccount {
  /** `${fiatCurrency}:${hash(accountInfo)}` — content-addressed so distinct bank details map to distinct Grid accounts. */
  key: string;
  createdAt: string;
}

export function isLightsparkExternalAccountActive(status: string): boolean {
  return status.trim().toUpperCase() === "ACTIVE";
}

/** Cache key for a payout account: same collected details always map to the same key, distinct details never collide. */
export async function lightsparkPayoutAccountKey(
  fiatCurrency: string,
  collectedData: CollectedFieldData
): Promise<string> {
  const fields = Object.entries(collectedData)
    .map(([key, value]) => `${key}=${value.trim()}`)
    .sort()
    .join("&");
  return `${fiatCurrency}:${(await hashString(fields)).slice(0, 16)}`;
}

export function readLightsparkData(
  providerData: CounterpartyProviderData
): Record<string, unknown> {
  const lightspark = providerData.lightspark;
  return lightspark && typeof lightspark === "object"
    ? (lightspark as Record<string, unknown>)
    : {};
}

export function readLightsparkCustomerId(providerData: CounterpartyProviderData): string | null {
  const customerId = readLightsparkData(providerData).customerId;
  return typeof customerId === "string" && customerId.length > 0 ? customerId : null;
}

export function readLightsparkPayoutAccounts(
  providerData: CounterpartyProviderData
): Record<string, unknown> {
  const payoutAccounts = readLightsparkData(providerData).payoutAccounts;
  return payoutAccounts && typeof payoutAccounts === "object"
    ? (payoutAccounts as Record<string, unknown>)
    : {};
}

function parseLightsparkPayoutAccountEntry(
  key: string,
  value: unknown
): LightsparkPayoutAccountEntry {
  const { accountId, status, createdAt } = value as {
    accountId?: unknown;
    status?: unknown;
    createdAt?: unknown;
  };
  if (
    typeof accountId !== "string" ||
    accountId.length === 0 ||
    typeof status !== "string" ||
    typeof createdAt !== "string"
  ) {
    throw new SdpPaymentsError(
      "INTERNAL_ERROR",
      `Malformed lightspark payout account entry "${key}" in provider_data`
    );
  }
  return { key, accountId, status, createdAt };
}

export function readLightsparkPayoutAccountByKey(
  providerData: CounterpartyProviderData,
  key: string
): LightsparkPayoutAccountEntry | null {
  const value = readLightsparkPayoutAccounts(providerData)[key];
  if (value === undefined) {
    return null;
  }
  return parseLightsparkPayoutAccountEntry(key, value);
}

export function latestLightsparkPayoutAccount(
  providerData: CounterpartyProviderData,
  fiatCurrency: string
): LightsparkPayoutAccountEntry | null {
  const entries = Object.entries(readLightsparkPayoutAccounts(providerData))
    .filter(([key]) => key.startsWith(`${fiatCurrency}:`))
    .map(([key, value]) => parseLightsparkPayoutAccountEntry(key, value))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return entries[0] ?? null;
}
