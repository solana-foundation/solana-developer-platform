import {
  type DashboardKeyScope,
  dashboardRequestKey,
  readsUnderPath,
} from "@/lib/dashboard-request-key";

// The API caps an organization at fewer people, pending invitations included, than one page holds.
const MEMBERS_PAGE_SIZE = 25;

export const membersQueryKeys = {
  directory: (scope: DashboardKeyScope, { page }: { page: number }) =>
    dashboardRequestKey(scope, "/api/dashboard/members", { page, pageSize: MEMBERS_PAGE_SIZE }),
  memberApiKeys: (scope: DashboardKeyScope, { memberId }: { memberId: string }) =>
    dashboardRequestKey(scope, `/api/dashboard/members/${encodeURIComponent(memberId)}/api-keys`),
};

export const memberReads = readsUnderPath("/api/dashboard/members");
