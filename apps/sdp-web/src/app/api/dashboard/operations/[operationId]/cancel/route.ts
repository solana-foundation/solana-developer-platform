import { proxyEarnCore } from "@/app/api/dashboard/markets/earn/core-proxy";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ operationId: string }> }
) {
  const { operationId } = await params;
  return proxyEarnCore(request, `/v1/operations/${encodeURIComponent(operationId)}/cancel`);
}
