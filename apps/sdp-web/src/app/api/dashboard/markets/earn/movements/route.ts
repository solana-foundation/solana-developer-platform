import { earnMovementsProxyQuery } from "@/app/api/dashboard/markets/earn/provider-query";
import { proxyValidatedGet } from "@/app/api/dashboard/markets/proxy-read";

export async function GET(request: Request) {
  return proxyValidatedGet(request, {
    validate: earnMovementsProxyQuery,
    traceSource: "route.dashboard.earn.movements.list",
    path: (query) => `/v1/earn/movements${query}`,
  });
}
