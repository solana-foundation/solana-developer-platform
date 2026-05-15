export interface DashboardCacheScope {
  userId: string | null;
  orgId: string | null;
}

export function getDashboardCacheScopeKey(scope: DashboardCacheScope): string {
  return `${scope.userId ?? "anonymous"}:${scope.orgId ?? "no-org"}`;
}
