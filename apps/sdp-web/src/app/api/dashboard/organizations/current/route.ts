import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { resolveOrganizationId } from "@/app/(session)/dashboard/[projectId]/settings/organization-id";
import { dashboardResponseHeaders } from "@/lib/dashboard-response";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createOrgSdpApiClient, proxyFailure, SdpApiResponseError } from "@/lib/sdp-api";

/**
 * The signed-in organization's record. The browser holds the Clerk organization, not the SDP id,
 * so this resolves the id from the onboarding status and reads the organization under it.
 */
export async function GET(request: Request) {
  const trace = createTimedTrace("route.dashboard.organizations.current", request);
  const { userId, orgId } = await auth();
  if (!userId) {
    return proxyFailure(trace, 401, "Authentication required");
  }
  if (!orgId) {
    return proxyFailure(trace, 403, "Active organization required");
  }

  try {
    const client = await createOrgSdpApiClient(
      trace.childContext("route.dashboard.organizations.current.api")
    );
    const organizationId = await trace.step("resolve_organization_id", () =>
      resolveOrganizationId(client)
    );
    if (organizationId === null) {
      return proxyFailure(trace, 404, "Organization is not linked yet");
    }
    const response = await trace.step("fetch_organization", () =>
      client.request(`/v1/organizations/${encodeURIComponent(organizationId)}`)
    );
    logRouteResult(trace, response.status);
    return new NextResponse(response.body, {
      status: response.status,
      headers: dashboardResponseHeaders(trace, {
        "Content-Type": response.headers.get("Content-Type") ?? "application/json",
      }),
    });
  } catch (error) {
    if (error instanceof SdpApiResponseError) {
      logRouteResult(trace, error.status);
      return new NextResponse(error.responseBody, {
        status: error.status,
        headers: dashboardResponseHeaders(trace, { "Content-Type": "application/json" }),
      });
    }
    return proxyFailure(
      trace,
      500,
      error instanceof Error ? error.message : "Organization read failed"
    );
  }
}
