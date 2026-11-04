import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { CounterpartyCreateProvider } from "@/app/(session)/dashboard/[projectId]/payments/counterparty/counterparty-create-context";
import { CounterpartyCreatePage } from "@/app/(session)/dashboard/[projectId]/payments/counterparty/counterparty-create-page";
import { redirectUnlessCanWrite } from "@/lib/require-write-access";

export default async function CounterpartyCreateRoute() {
  const { orgId } = await auth();
  if (!orgId) {
    redirect("/dashboard");
  }
  await redirectUnlessCanWrite("/dashboard/payments/counterparty");

  return (
    <CounterpartyCreateProvider>
      <CounterpartyCreatePage />
    </CounterpartyCreateProvider>
  );
}
