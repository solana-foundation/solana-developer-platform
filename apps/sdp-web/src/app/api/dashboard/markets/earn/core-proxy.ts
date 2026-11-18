import { dashboardJson } from "@/lib/dashboard-response";
import { proxyToSdpApi } from "@/lib/sdp-api";

/** Preserve typed filters exactly; unknown or repeated filters must never broaden a money read. */
export function proxyEarnCore(request: Request, path: string, allowed: readonly string[] = []) {
  const query = new URL(request.url).searchParams;
  const allowedKeys = new Set(allowed);
  const seen = new Set<string>();
  for (const key of query.keys()) {
    if (!allowedKeys.has(key) || seen.has(key)) {
      return Promise.resolve(
        dashboardJson(
          { error: { message: `Invalid or repeated query parameter: ${key}` } },
          { status: 400 }
        )
      );
    }
    seen.add(key);
  }
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.core",
    path: `${path}${query.size > 0 ? `?${query}` : ""}`,
  });
}
