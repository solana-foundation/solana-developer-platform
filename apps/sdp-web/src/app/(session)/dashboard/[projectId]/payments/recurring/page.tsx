import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { issuance } from "@/flags";
import { parseRecurringPaymentsListParams } from "./recurring-payments.data";
import { RecurringPaymentsWorkspace } from "./recurring-payments-workspace";

interface RecurringPaymentsPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function RecurringPaymentsPage({ searchParams }: RecurringPaymentsPageProps) {
  const { orgId } = await auth();
  if (!orgId) {
    redirect("/dashboard");
  }

  const [params, issuanceEnabled] = await Promise.all([searchParams, issuance()]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <RecurringPaymentsWorkspace
        listState={parseRecurringPaymentsListParams(params ?? {})}
        issuanceEnabled={issuanceEnabled}
      />
    </div>
  );
}
