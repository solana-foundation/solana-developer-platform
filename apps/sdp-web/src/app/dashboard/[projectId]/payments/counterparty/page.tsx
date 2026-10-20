import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { resolvePlaygroundApiBaseUrl } from "@/app/dashboard/[projectId]/playground-api-data";
import { withLegacyDesign } from "@/flags/new-design";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import { fetchCounterparties } from "./counterparty-page.data";
import { CounterpartyWorkspace } from "./counterparty-workspace";
import { CounterpartyPage as RedesignCounterpartyPage } from "./page.redesign";

export const dynamic = "force-dynamic";

async function CounterpartyPage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const apiBaseUrl = resolvePlaygroundApiBaseUrl();

  return withDashboardPageTrace("dashboard.counterparty.page", async ({ trace, apiClient }) => {
    const [counterpartiesResult] = await Promise.all([
      trace.step("fetch_counterparties", () => fetchCounterparties(apiClient.request)),
    ]);

    trace.log({
      ok: true,
      counterpartiesOk: counterpartiesResult.ok,
      counterpartiesCount: counterpartiesResult.data.length,
      counterpartiesTotal: counterpartiesResult.total,
    });

    return (
      <div className="flex h-full min-h-0 w-full flex-col">
        <CounterpartyWorkspace
          initialCounterparties={counterpartiesResult.data}
          initialTotal={counterpartiesResult.total}
          apiBaseUrl={apiBaseUrl}
        />
      </div>
    );
  });
}

export default withLegacyDesign(RedesignCounterpartyPage, CounterpartyPage, "contacts");
