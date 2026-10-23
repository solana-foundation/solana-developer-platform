import { vaultPositionsProxyQuery } from "@/app/api/dashboard/markets/earn/provider-query";
import { proxyValidatedGet } from "@/app/api/dashboard/markets/proxy-read";

export async function GET(request: Request) {
  return proxyValidatedGet(request, {
    validate: vaultPositionsProxyQuery,
    traceSource: "route.dashboard.earn.vault_positions.list",
    path: (query) => `/v1/earn/vault-positions${query}`,
  });
}
