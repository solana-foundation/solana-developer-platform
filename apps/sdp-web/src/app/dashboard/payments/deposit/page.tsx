import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { loadPaymentsActionPageData } from "../ramps/payments-action-page.server";
import { PaymentsActionPage } from "../ramps/ramp-action-page";

export default async function PaymentsDepositPage() {
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
