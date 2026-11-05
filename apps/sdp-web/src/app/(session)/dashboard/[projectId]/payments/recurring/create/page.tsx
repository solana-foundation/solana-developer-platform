import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { RecurringPaymentCreateWorkspace } from "@/app/(session)/dashboard/[projectId]/payments/recurring/recurring-payment-create-workspace";
import { issuance } from "@/flags";
import { redirectUnlessCanWrite } from "@/lib/require-write-access";

export default async function RecurringPaymentCreatePage() {
  const { orgId } = await auth();
  if (!orgId) {
    redirect("/dashboard");
  }
  await redirectUnlessCanWrite("/dashboard/payments/recurring");

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <RecurringPaymentCreateWorkspace issuanceEnabled={await issuance()} />
    </div>
  );
}
