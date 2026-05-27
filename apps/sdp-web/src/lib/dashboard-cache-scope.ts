import type { SdpEnvironment } from "@sdp/types";

export interface DashboardCacheScope {
  userId: string | null;
  orgId: string | null;
}

interface DashboardCacheScopeKeyOptions {
  environment?: SdpEnvironment;
}

export function getDashboardCacheScopeKey(
  scope: DashboardCacheScope,
  options: DashboardCacheScopeKeyOptions = {}
): string {
  const baseKey = `${scope.userId ?? "anonymous"}:${scope.orgId ?? "no-org"}`;
  return options.environment ? `${baseKey}:${options.environment}` : baseKey;
}
