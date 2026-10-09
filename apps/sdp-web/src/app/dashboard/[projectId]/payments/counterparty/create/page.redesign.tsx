import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { CounterpartyCreateProvider } from "../counterparty-create-context.redesign";
import { CounterpartyCreatePage } from "../counterparty-create-page.redesign";

async function CounterpartyCreateRoute() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  return (
    <CounterpartyCreateProvider>
      <CounterpartyCreatePage />
    </CounterpartyCreateProvider>
  );
}

export default CounterpartyCreateRoute;
