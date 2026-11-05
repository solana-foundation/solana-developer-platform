import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { PaymentsActionPage } from "@/app/(session)/dashboard/[projectId]/payments/ramps/ramp-action-page";
import { issuance } from "@/flags";
import { getEnabledRampProviders } from "@/flags/ramps";

export default async function PaymentsDepositPage() {
  const { orgId } = await auth();
  if (!orgId) {
    redirect("/dashboard");
  }

  const [enabledRampProviders, issuanceEnabled] = await Promise.all([
    getEnabledRampProviders(),
    issuance(),
  ]);
  return (
    <PaymentsActionPage
      mode="receive"
      enabledRampProviders={enabledRampProviders}
      issuanceEnabled={issuanceEnabled}
    />
  );
}
