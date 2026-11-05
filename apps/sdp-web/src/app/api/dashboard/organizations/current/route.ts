import { proxyCurrentOrganizationRead } from "./current-organization-proxy";

export async function GET(request: Request) {
  return proxyCurrentOrganizationRead(
    request,
    "route.dashboard.organizations.current",
    (organizationId) => `/v1/organizations/${encodeURIComponent(organizationId)}`
  );
}
