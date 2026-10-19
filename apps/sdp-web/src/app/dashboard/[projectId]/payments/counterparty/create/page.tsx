import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { CounterpartyCreateProvider } from "@/app/dashboard/[projectId]/payments/counterparty/counterparty-create-context";
import { CounterpartyCreatePage } from "@/app/dashboard/[projectId]/payments/counterparty/counterparty-create-page";
import { withLegacyDesign } from "@/flags/new-design";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { CounterpartyCreateRoute as RedesignCounterpartyCreateRoute } from "./page.redesign";

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

export default withLegacyDesign(
  RedesignCounterpartyCreateRoute,
  CounterpartyCreateRoute,
  "contacts"
);
