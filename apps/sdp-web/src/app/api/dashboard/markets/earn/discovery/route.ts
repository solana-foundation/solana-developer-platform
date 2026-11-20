import { proxyEarnCore } from "@/app/api/dashboard/markets/earn/core-proxy";

export function GET(request: Request) {
  return proxyEarnCore(request, "/v1/earn/discovery", [
    "id",
    "provider",
    "depositMint",
    "sourceKind",
    "apyType",
    "minApy",
    "maxApy",
    "liquidityTerm",
    "cluster",
    "page",
    "pageSize",
  ]);
}
