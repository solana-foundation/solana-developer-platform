import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { PaymentRequestCreateWorkspace } from "@/app/(session)/dashboard/[projectId]/payments/requests/payment-request-create-workspace";
import { PAYMENT_REQUESTS_HREF } from "@/lib/payments-routes";
import { redirectUnlessCanWrite } from "@/lib/require-write-access";

export default async function PaymentRequestCreatePage() {
  const { orgId } = await auth();
  if (!orgId) {
    redirect("/dashboard");
  }
  await redirectUnlessCanWrite(PAYMENT_REQUESTS_HREF);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <PaymentRequestCreateWorkspace />
    </div>
  );
}
