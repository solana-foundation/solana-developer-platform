import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { loadPaymentsActionPageData } from "@/app/dashboard/[projectId]/payments/ramps/payments-action-page.server";
import { PaymentsActionPage } from "@/app/dashboard/[projectId]/payments/ramps/ramp-action-page";
import { withLegacyDesign } from "@/flags/new-design";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { PaymentsDepositPage as RedesignPaymentsDepositPage } from "./page.redesign";

async function PaymentsDepositPage() {
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

export default withLegacyDesign(RedesignPaymentsDepositPage, PaymentsDepositPage, "payDeposit");
