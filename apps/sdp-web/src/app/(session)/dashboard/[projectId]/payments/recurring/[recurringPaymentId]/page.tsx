import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { RecurringPaymentDetailRoute } from "@/app/(session)/dashboard/[projectId]/payments/recurring/recurring-payment-detail-workspace";
import { issuance } from "@/flags";

export default async function RecurringPaymentDetailPage({
  params,
}: {
  params: Promise<{ recurringPaymentId: string }>;
}) {
  const { orgId } = await auth();
  if (!orgId) {
    redirect("/dashboard");
  }

  const [{ recurringPaymentId }, issuanceEnabled] = await Promise.all([params, issuance()]);

  return (
    <RecurringPaymentDetailRoute
      recurringPaymentId={recurringPaymentId}
      issuanceEnabled={issuanceEnabled}
    />
  );
}
