import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { withLegacyDesign } from "@/flags/new-design";
import { getAuthEntryPath } from "@/lib/auth-entry";
import LegacyPaymentsPayPage from "../_legacy/pay/page";
import { PaymentsPayPageSkeleton } from "../payments-route-skeletons";
import { loadPaymentsActionPageData } from "../ramps/payments-action-page.server";
import { PaymentsActionPage } from "../ramps/ramp-action-page";

async function PaymentsPayPage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const actionPageData = await loadPaymentsActionPageData({ includePrivateSendStatus: true });
  // The flow reads the contact to preselect from the URL, so it gets its own boundary; the
  // fallback is the route's loading skeleton.
  return (
    <Suspense fallback={<PaymentsPayPageSkeleton />}>
      <PaymentsActionPage mode="send" wallets={[]} walletsError={null} {...actionPageData} />
    </Suspense>
  );
}

export default withLegacyDesign(PaymentsPayPage, LegacyPaymentsPayPage);
