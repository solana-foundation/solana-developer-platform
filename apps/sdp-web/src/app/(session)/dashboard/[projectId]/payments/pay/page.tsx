import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { PaymentsActionPage } from "@/app/(session)/dashboard/[projectId]/payments/ramps/ramp-action-page";
import { issuance, privateChannels } from "@/flags";
import { getEnabledRampProviders } from "@/flags/ramps";
import { redirectUnlessCanWrite } from "@/lib/require-write-access";

export default async function PaymentsPayPage() {
  const { orgId } = await auth();
  if (!orgId) {
    redirect("/dashboard");
  }
  await redirectUnlessCanWrite("/dashboard/payments");

  const [enabledRampProviders, issuanceEnabled, privateChannelsEnabled] = await Promise.all([
    getEnabledRampProviders(),
    issuance(),
    privateChannels(),
  ]);
  return (
    <PaymentsActionPage
      mode="send"
      enabledRampProviders={enabledRampProviders}
      issuanceEnabled={issuanceEnabled}
      privateChannelsEnabled={privateChannelsEnabled}
    />
  );
}
