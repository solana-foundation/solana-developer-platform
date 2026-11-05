import { DvpTradeDetailClient } from "@/app/(session)/dashboard/[projectId]/markets/dvp/dvp-trade-detail-client";

export default async function DvpTradeDetailPage({
  params,
}: {
  params: Promise<{ tradeId: string }>;
}) {
  const { tradeId } = await params;
  return <DvpTradeDetailClient tradeId={tradeId} />;
}
