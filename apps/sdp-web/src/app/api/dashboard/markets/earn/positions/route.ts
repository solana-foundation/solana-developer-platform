import { proxyEarnCore } from "@/app/api/dashboard/markets/earn/core-proxy";

export function GET(request: Request) {
  return proxyEarnCore(request, "/v1/earn/positions", [
    "walletId",
    "ownerAddress",
    "sourceType",
    "limit",
    "before",
    "discover",
    "afterMovementIds",
    "includeSummary",
    "includeOwnerAddresses",
    "includePositions",
  ]);
}
