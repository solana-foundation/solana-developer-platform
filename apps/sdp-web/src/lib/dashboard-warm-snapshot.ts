import type { CustodyWalletAggregate, CustodyWalletSummary } from "@sdp/types";
import type { KnownCustodyProvider } from "@/app/dashboard/custody/provider-catalog";

export const DASHBOARD_WARM_SNAPSHOT_KEY = "dashboard-warm-snapshot";
export const DASHBOARD_WARM_SNAPSHOT_ROUTE = "/api/dashboard/warm-snapshot";
export const DASHBOARD_WARM_SNAPSHOT_STALE_MS = 60_000;
export const DASHBOARD_WARM_SNAPSHOT_REFRESH_MS = 30_000;

export type DashboardWarmSnapshotSliceStatus = "fresh" | "refreshing" | "error";

export interface DashboardWarmSnapshotSlice<T> {
  data: T;
  status: DashboardWarmSnapshotSliceStatus;
  generatedAt: string;
  staleAt: string;
  error: string | null;
}

export type DashboardApiKeyRole = "api_admin" | "api_developer" | "api_readonly";
export type DashboardApiKeyEnvironment = "sandbox" | "production";
export type DashboardApiKeyStatus = "active" | "revoked" | "expired" | "deactivated";

export interface DashboardApiKeyView {
  id: string;
  name: string;
  keyPrefix: string;
  role: DashboardApiKeyRole;
  environment: DashboardApiKeyEnvironment;
  status: DashboardApiKeyStatus;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface DashboardIssuedTokenView {
  id: string;
  name: string;
  symbol: string;
  status: string;
  template: string;
  imageUrl: string | null;
  mintAddress: string | null;
  totalSupply: string;
  createdAt: string;
  deployedAt: string | null;
}

export interface DashboardWalletProviderStatus {
  connectedProviders: KnownCustodyProvider[];
  enabledProviders: KnownCustodyProvider[];
  configsError: string | null;
}

export interface DashboardWarmSnapshot {
  generatedAt: string;
  staleAt: string;
  wallets: DashboardWarmSnapshotSlice<CustodyWalletSummary[]>;
  aggregateBalance: DashboardWarmSnapshotSlice<CustodyWalletAggregate | null>;
  issuedTokens: DashboardWarmSnapshotSlice<DashboardIssuedTokenView[]>;
  apiKeys: DashboardWarmSnapshotSlice<DashboardApiKeyView[]>;
  walletProviderStatus: DashboardWarmSnapshotSlice<DashboardWalletProviderStatus>;
}

export function createDashboardWarmSnapshotSlice<T>({
  data,
  error = null,
  generatedAt,
  staleAt,
  status,
}: {
  data: T;
  error?: string | null;
  generatedAt: string;
  staleAt: string;
  status?: DashboardWarmSnapshotSliceStatus;
}): DashboardWarmSnapshotSlice<T> {
  return {
    data,
    error,
    generatedAt,
    staleAt,
    status: status ?? (error ? "error" : "fresh"),
  };
}

export function getWarmSnapshotSliceError<T>(
  slice: DashboardWarmSnapshotSlice<T> | undefined,
  fallback: string | null = null
): string | null {
  if (!slice) {
    return fallback;
  }

  return slice.error;
}

export function getActiveWarmSnapshotApiKeys(
  apiKeys: DashboardApiKeyView[]
): Array<Pick<DashboardApiKeyView, "id" | "name" | "keyPrefix" | "role" | "environment">> {
  return apiKeys
    .filter((apiKey) => apiKey.status === "active")
    .map((apiKey) => ({
      id: apiKey.id,
      name: apiKey.name,
      keyPrefix: apiKey.keyPrefix,
      role: apiKey.role,
      environment: apiKey.environment,
    }));
}
