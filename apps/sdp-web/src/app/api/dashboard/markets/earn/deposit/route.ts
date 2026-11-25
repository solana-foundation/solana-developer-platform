import { proxyEarnCore } from "@/app/api/dashboard/markets/earn/core-proxy";

export function POST(request: Request) {
  return proxyEarnCore(request, "/v1/earn/deposit");
}
