import { dashboardJson } from "@/lib/dashboard-response";
import { proxyToSdpApi } from "@/lib/sdp-api";

const TRADE_LIST_PARAMS = ["limit", "status", "settlementAvailability", "q"] as const;

/**
 * The upstream list takes `limit` (1..100) and the server-side filters the trades page sends.
 * Validating here rather than forwarding the query wholesale keeps an unknown parameter from
 * reaching the API as a silently ignored filter — a caller who thinks they filtered and did not is
 * worse served than one who gets a 400. The filter values themselves are the API's to judge.
 */
function tradesQuery(
  request: Request
): { ok: true; query: string } | { ok: false; message: string } {
  const url = new URL(request.url);
  const forwarded = new URLSearchParams();
  for (const [name, value] of url.searchParams) {
    if (!(TRADE_LIST_PARAMS as readonly string[]).includes(name)) {
      return { ok: false, message: `Unsupported query parameter: ${name}` };
    }
    if (forwarded.has(name)) {
      return { ok: false, message: `Repeated query parameter: ${name}` };
    }
    forwarded.set(name, value);
  }

  const limit = forwarded.get("limit");
  if (limit !== null && (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)) {
    return { ok: false, message: "limit must be an integer between 1 and 100" };
  }
  const query = forwarded.toString();
  return { ok: true, query: query === "" ? "" : `?${query}` };
}

export async function GET(request: Request) {
  const validated = tradesQuery(request);
  if (!validated.ok) {
    return dashboardJson({ error: { message: validated.message } }, { status: 400 });
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
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.dvp.trades.create",
    path: "/v1/dvp/trades",
  });
}
