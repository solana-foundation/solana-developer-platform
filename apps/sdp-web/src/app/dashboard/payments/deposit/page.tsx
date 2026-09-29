import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { withLegacyDesign } from "@/flags/new-design";
import { getAuthEntryPath } from "@/lib/auth-entry";
import LegacyPaymentsDepositPage from "../_legacy/deposit/page";
import { loadPaymentsActionPageData } from "../ramps/payments-action-page.server";
import { PaymentsActionPage } from "../ramps/ramp-action-page";

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

export default withLegacyDesign(PaymentsDepositPage, LegacyPaymentsDepositPage);
