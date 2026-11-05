import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { TransactionDetailWorkspace } from "@/app/(session)/dashboard/[projectId]/payments/transactions/transaction-detail-workspace";
import { issuance } from "@/flags";

export default async function TransactionDetailRoute({
  params,
}: {
  params: Promise<{ transactionId: string }>;
}) {
  const { orgId } = await auth();
  if (!orgId) {
    redirect("/dashboard");
  }

  const [{ transactionId }, issuanceEnabled] = await Promise.all([params, issuance()]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <TransactionDetailWorkspace transactionId={transactionId} issuanceEnabled={issuanceEnabled} />
    </div>
  );
}
