import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { parsePaymentRequestsListParams } from "./payment-requests-page.data";
import { PaymentRequestsWorkspace } from "./payment-requests-workspace";

export default async function PaymentRequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId } = await auth();
  if (!orgId) {
    redirect("/dashboard");
  }

  return (
    <PaymentRequestsWorkspace listState={parsePaymentRequestsListParams(await searchParams)} />
  );
}
