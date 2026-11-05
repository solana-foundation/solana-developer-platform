import {
  type DashboardKeyScope,
  dashboardRequestKey,
  readsUnderPath,
} from "@/lib/dashboard-request-key";

export const membersQueryKeys = {
  memberApiKeys: (scope: DashboardKeyScope, { memberId }: { memberId: string }) =>
    dashboardRequestKey(scope, `/api/dashboard/members/${encodeURIComponent(memberId)}/api-keys`),
};

export const memberReads = readsUnderPath("/api/dashboard/members");
