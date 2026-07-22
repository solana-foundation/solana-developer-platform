import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { isEarnUiEnabled } from "@/lib/earn-feature";
import { EarnDepositWizard } from "./earn-deposit-wizard";

export const dynamic = "force-dynamic";

interface EarnDepositPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function EarnDepositPage({ searchParams }: EarnDepositPageProps) {
  if (!isEarnUiEnabled()) {
    redirect("/dashboard");
  }

  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const resolved = searchParams ? await searchParams : undefined;
  const strategyParam = resolved?.strategy;
  const initialStrategyId = Array.isArray(strategyParam) ? strategyParam[0] : strategyParam;

  return <EarnDepositWizard initialStrategyId={initialStrategyId} />;
}
