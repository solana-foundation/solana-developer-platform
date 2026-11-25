import { proxyEarnCore } from "@/app/api/dashboard/markets/earn/core-proxy";

export function GET(request: Request) {
  return proxyEarnCore(request, "/v1/operations", [
    "operationIds",
    "kind",
    "status",
    "ownerAddress",
    "walletId",
    "positionId",
    "limit",
    "cursor",
  ]);
}
