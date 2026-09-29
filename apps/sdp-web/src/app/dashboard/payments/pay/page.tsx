import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { withLegacyDesign } from "@/flags/new-design";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { loadPaymentsActionPageData } from "../ramps/payments-action-page.server";
import { PaymentsActionPage } from "../ramps/ramp-action-page";
import RedesignPaymentsPayPage from "./page.redesign";

async function PaymentsPayPage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const actionPageData = await loadPaymentsActionPageData();
  return <PaymentsActionPage mode="send" wallets={[]} walletsError={null} {...actionPageData} />;
}

export default withLegacyDesign(RedesignPaymentsPayPage, PaymentsPayPage, "payDeposit");
