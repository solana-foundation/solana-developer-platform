import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { PaymentRequestDetailWorkspace } from "@/app/(session)/dashboard/[projectId]/payments/requests/payment-request-detail-workspace";

export default async function PaymentRequestDetailRoute({
  params,
}: {
  params: Promise<{ requestId: string }>;
}) {
  const { orgId } = await auth();
  if (!orgId) {
    redirect("/dashboard");
  }

  const { requestId } = await params;
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <PaymentRequestDetailWorkspace requestId={requestId} />
    </div>
  );
}
