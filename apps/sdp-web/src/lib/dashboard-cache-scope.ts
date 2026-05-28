export interface DashboardCacheScope {
  userId: string;
  orgId: string;
}

interface DashboardCacheScopeKeyOptions {
  projectId?: string | null;
}

export function getDashboardCacheScopeKey(
  scope: DashboardCacheScope,
  options: DashboardCacheScopeKeyOptions = {}
): string {
  const baseKey = `${scope.userId}:${scope.orgId}`;
  return options.projectId ? `${baseKey}:${options.projectId}` : baseKey;
}
