import { auth } from "@clerk/nextjs/server";
import { RENDER_SCOPE_HEADER_NAME } from "@/lib/project-cookie";
import { verifyRenderScope } from "@/lib/render-scope";
import { createTimedTrace } from "@/lib/request-tracing";
import { getSelectedProjectId, proxyFailure, proxyToSdpApi } from "@/lib/sdp-api";

const TRACE_SOURCE = "route.dashboard.payment-requests.create";

const STALE_PAGE_MESSAGE = "This page is out of date. Reload the page and try again.";

/**
 * Payment-request creation is bound to the render scope of the page that
 * rendered the form (APE-706, SOLA9-424). The shared project cookie is read
 * fresh on every submission, so without this binding a tab that rendered
 * under project A could persist its request under project B after a sibling
 * tab moved the cookie — even though the org-level custody wallet resolves
 * in both projects. The sealed scope minted by the page must exist, belong
 * to the calling Clerk session, and name the project the cookie resolves to
 * right now; anything else fails closed instead of guessing attribution.
 */
export async function POST(request: Request) {
  const projectId = await getSelectedProjectId();

  if (projectId) {
    const { sessionId, userId } = await auth();
    const verification = await verifyRenderScope(
      request.headers.get(RENDER_SCOPE_HEADER_NAME),
      { sessionId, userId },
      projectId
    );
    if (!verification.ok) {
      if (verification.reason === "unauthenticated") {
        return proxyFailure(
          createTimedTrace(TRACE_SOURCE, request),
          401,
          "Authentication required"
        );
      }
      const message =
        verification.reason === "project_mismatch"
          ? "Project selection changed. Reload the page and try again."
          : STALE_PAGE_MESSAGE;
      return proxyFailure(createTimedTrace(TRACE_SOURCE, request), 409, message);
    }
  }

  return proxyToSdpApi({
    request,
    traceSource: TRACE_SOURCE,
    path: "/v1/payments/requests",
  });
}
