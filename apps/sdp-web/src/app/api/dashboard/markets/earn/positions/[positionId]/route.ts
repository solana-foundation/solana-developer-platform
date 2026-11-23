import { proxyEarnCore } from "@/app/api/dashboard/markets/earn/core-proxy";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ positionId: string }> }
) {
  const { positionId } = await params;
  return proxyEarnCore(request, `/v1/earn/positions/${encodeURIComponent(positionId)}`, [
    "afterMovementIds",
  ]);
}
