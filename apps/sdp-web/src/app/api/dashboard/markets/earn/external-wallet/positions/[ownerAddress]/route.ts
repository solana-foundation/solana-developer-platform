import { externalWalletPositionsProxyQuery } from "@/app/api/dashboard/markets/earn/provider-query";
import { proxyValidatedGet } from "@/app/api/dashboard/markets/proxy-read";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ ownerAddress: string }> }
) {
  const { ownerAddress } = await params;
  // The API addresses the owner as a required query filter (the shape every
  // per-owner external-wallet read shares); this route keeps its dashboard
  // path-param shape and translates.
  return proxyValidatedGet(request, {
    validate: externalWalletPositionsProxyQuery,
    traceSource: "route.dashboard.earn.external_wallet_positions.list",
    path: (query) =>
      `/v1/earn/external-wallet/positions?ownerAddress=${encodeURIComponent(ownerAddress)}${query.replace(/^\?/, "&")}`,
  });
}
