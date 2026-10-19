import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { loadPaymentsActionPageData } from "@/app/dashboard/[projectId]/payments/ramps/payments-action-page.server";
import { PaymentsActionPage } from "@/app/dashboard/[projectId]/payments/ramps/ramp-action-page.redesign";
import { getAuthEntryPath } from "@/lib/auth-entry";

export async function PaymentsDepositPage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const actionPageData = await loadPaymentsActionPageData();
  return <PaymentsActionPage mode="receive" wallets={[]} walletsError={null} {...actionPageData} />;
}
