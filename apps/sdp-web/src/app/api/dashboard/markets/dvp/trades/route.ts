import { DVP_CREATE_REFUSAL } from "@sdp/types";
import { NextResponse } from "next/server";
import { forwardedIdempotencyHeaders } from "@/lib/idempotency";
import { REVIEWED_PROJECT_HEADER_NAME } from "@/lib/project-cookie";
import { createTimedTrace } from "@/lib/request-tracing";
import { getSelectedProjectId, proxyFailure, proxyToSdpApi } from "@/lib/sdp-api";

/**
 * The upstream list takes only `limit` (1..100). Validating here rather than
 * forwarding the query wholesale keeps an unknown parameter from reaching the
 * API as a silently ignored filter — a caller who thinks they filtered and did
 * not is worse served than one who gets a 400.
 */
function tradesQuery(
  request: Request
): { ok: true; query: string } | { ok: false; message: string } {
  const url = new URL(request.url);
  for (const key of url.searchParams.keys()) {
    if (key !== "limit") {
      return { ok: false, message: `Unsupported query parameter: ${key}` };
    }
  }

  const limit = url.searchParams.get("limit");
  if (limit === null) {
    return { ok: true, query: "" };
  }
  if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) {
    return { ok: false, message: "limit must be an integer between 1 and 100" };
  }
  return { ok: true, query: `?limit=${limit}` };
}

export async function GET(request: Request) {
  const validated = tradesQuery(request);
  if (!validated.ok) {
    return NextResponse.json({ error: { message: validated.message } }, { status: 400 });
  }

  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.dvp.trades.list",
    path: `/v1/dvp/trades${validated.query}`,
  });
}

/**
 * A local refusal that never reaches the upstream API. `proxyFailure` carries
 * the same envelope and headers `proxyToSdpApi` uses for its own local
 * failures, and `reason` is a stable code the create form names in its own
 * words (localized) instead of relaying this message.
 */
function refusal(request: Request, status: number, reason: string, message: string): NextResponse {
  return proxyFailure(
    createTimedTrace("route.dashboard.dvp.trades.create", request),
    status,
    message,
    { reason }
  );
}

/**
 * Create. The Idempotency-Key is forwarded deliberately: it is what makes a
 * double submit, or a retry after a dropped connection, return the original
 * trade instead of creating a second one at a second address.
 *
 * The create form is reviewed under one project, but the shared selection
 * cookie is mutable while the wizard is mounted (APE-693): rereading it at
 * submit time let a trade reviewed under project A be recorded under sibling
 * project B — custody, sponsorship and all. The submit therefore presents the
 * project it was reviewed under, and this route forwards ONLY when that is
 * still the selected project. The binding header itself stays local; the
 * upstream project remains the server's own resolution.
 */
export async function POST(request: Request) {
  const reviewedProjectId = request.headers.get(REVIEWED_PROJECT_HEADER_NAME);
  if (!reviewedProjectId) {
    return refusal(
      request,
      400,
      DVP_CREATE_REFUSAL.reviewedProjectRequired,
      "Create must present the project it was reviewed under"
    );
  }
  const selectedProjectId = await getSelectedProjectId();
  if (!selectedProjectId) {
    return proxyFailure(
      createTimedTrace("route.dashboard.dvp.trades.create", request),
      400,
      "Selected project required"
    );
  }
  if (reviewedProjectId !== selectedProjectId) {
    return refusal(
      request,
      409,
      DVP_CREATE_REFUSAL.reviewedProjectMismatch,
      "The selected project changed since this trade was reviewed. Review it under the current project and create it again."
    );
  }

  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.dvp.trades.create",
    path: "/v1/dvp/trades",
    upstreamHeaders: forwardedIdempotencyHeaders(request),
  });
}
