import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { PaymentsPayPageSkeleton } from "@/app/(session)/dashboard/[projectId]/payments/payments-route-skeletons";
import { loadPaymentsActionPageData } from "@/app/(session)/dashboard/[projectId]/payments/ramps/payments-action-page.server";
import { PaymentsActionPage } from "@/app/(session)/dashboard/[projectId]/payments/ramps/ramp-action-page";
import { redirectUnlessCanWrite } from "@/lib/require-write-access";

export default async function PaymentsPayPage() {
  const { orgId } = await auth();
  if (!orgId) {
    redirect("/dashboard");
  }
  await redirectUnlessCanWrite("/dashboard/payments");

  const actionPageData = await loadPaymentsActionPageData({ includePrivateSendStatus: true });
  // The flow reads the contact to preselect from the URL, so it gets its own boundary; the
  // fallback is the route's loading skeleton.
  return (
    <Suspense fallback={<PaymentsPayPageSkeleton />}>
      <PaymentsActionPage mode="send" wallets={[]} walletsError={null} {...actionPageData} />
    </Suspense>
  );
}
