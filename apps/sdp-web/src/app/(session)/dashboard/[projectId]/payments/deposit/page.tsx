import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { loadPaymentsActionPageData } from "@/app/(session)/dashboard/[projectId]/payments/ramps/payments-action-page.server";
import { PaymentsActionPage } from "@/app/(session)/dashboard/[projectId]/payments/ramps/ramp-action-page";

export default async function PaymentsDepositPage() {
  const { orgId } = await auth();
  if (!orgId) {
    redirect("/dashboard");
  }

  const actionPageData = await loadPaymentsActionPageData();
  return <PaymentsActionPage mode="receive" wallets={[]} walletsError={null} {...actionPageData} />;
}
