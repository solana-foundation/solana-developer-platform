import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { CounterpartyDetailRoute } from "@/app/(session)/dashboard/[projectId]/payments/counterparty/counterparty-detail-workspace";
import { isRampsEnabled } from "@/flags/ramps";

export default async function CounterpartyDetailPage({
  params,
}: {
  params: Promise<{ counterpartyId: string }>;
}) {
  const { orgId } = await auth();
  if (!orgId) {
    redirect("/dashboard");
  }

  const [{ counterpartyId }, rampsEnabled] = await Promise.all([params, isRampsEnabled()]);

  return <CounterpartyDetailRoute counterpartyId={counterpartyId} rampsEnabled={rampsEnabled} />;
}
