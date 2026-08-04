import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { EarnDepositWizard } from "./earn-deposit-wizard";

export const dynamic = "force-dynamic";

interface EarnDepositPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function EarnDepositPage({ searchParams }: EarnDepositPageProps) {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  // The wizard is curator-first by design, so the legacy ?start=curator entry
  // needs no special handling — every entry lands on the curator step.
  const resolved = searchParams ? await searchParams : undefined;
  const strategyParam = resolved?.strategy;
  const curatorParam = resolved?.curator;
  const initialStrategyId = Array.isArray(strategyParam) ? strategyParam[0] : strategyParam;
  const initialCuratorId = Array.isArray(curatorParam) ? curatorParam[0] : curatorParam;

  return (
    <EarnDepositWizard initialStrategyId={initialStrategyId} initialCuratorId={initialCuratorId} />
  );
}
