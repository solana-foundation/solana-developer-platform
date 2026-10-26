import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { CounterpartyCreateProvider } from "@/app/dashboard/[projectId]/payments/counterparty/counterparty-create-context.redesign";
import { CounterpartyCreatePage } from "@/app/dashboard/[projectId]/payments/counterparty/counterparty-create-page.redesign";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { redirectUnlessCanWrite } from "@/lib/require-write-access";

export async function CounterpartyCreateRoute() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
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
