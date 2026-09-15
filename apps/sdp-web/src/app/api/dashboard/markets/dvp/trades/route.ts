import { NextResponse } from "next/server";
import { proxyToSdpApi } from "@/lib/sdp-api";

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
 * Create. The Idempotency-Key is forwarded deliberately: it is what makes a
 * double submit, or a retry after a dropped connection, return the original
 * trade instead of creating a second one at a second address.
 */
export async function POST(request: Request) {
  const idempotencyKey = request.headers.get("Idempotency-Key");
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.dvp.trades.create",
    path: "/v1/dvp/trades",
    upstreamHeaders: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
  });
}
