import { proxyCurrentOrganizationRead } from "@/app/api/dashboard/organizations/current/current-organization-proxy";

export async function GET(request: Request) {
  return proxyCurrentOrganizationRead(
    request,
    "route.dashboard.organizations.current.provider-access",
    (organizationId) => `/v1/organizations/${encodeURIComponent(organizationId)}/provider-access`
  );
}
