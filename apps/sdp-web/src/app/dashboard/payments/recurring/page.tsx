import { auth } from "@clerk/nextjs/server";
import { notFound, redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { isRecurringPaymentsDashboardEnabled } from "@/lib/recurring-payments-feature";
import { RecurringPaymentsWorkspace } from "./recurring-payments-workspace";

export const dynamic = "force-dynamic";

export default async function RecurringPaymentsPage() {
  if (!isRecurringPaymentsDashboardEnabled()) {
    notFound();
  }

  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  return <RecurringPaymentsWorkspace />;
}
