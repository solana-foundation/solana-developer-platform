import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import { fetchActiveApiKeys, resolvePlaygroundApiBaseUrl } from "../../playground-api-data";
import { fetchCounterparties } from "./counterparty-page.data";
import { CounterpartyWorkspace } from "./counterparty-workspace";

export const dynamic = "force-dynamic";

export default async function CounterpartyPage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const apiBaseUrl = resolvePlaygroundApiBaseUrl();

  return withDashboardPageTrace("dashboard.counterparty.page", async ({ trace, apiClient }) => {
    const [counterpartiesResult, apiKeysResult] = await Promise.all([
      trace.step("fetch_counterparties", () => fetchCounterparties(apiClient.request)),
      trace.step("fetch_active_api_keys", () => fetchActiveApiKeys(apiClient.request)),
    ]);

    trace.log({
      ok: true,
      counterpartiesOk: counterpartiesResult.ok,
      counterpartiesCount: counterpartiesResult.data.length,
      counterpartiesTotal: counterpartiesResult.total,
      apiKeysOk: apiKeysResult.ok,
      apiKeysCount: apiKeysResult.data?.length ?? 0,
    });

    return (
      <div className="flex h-full min-h-0 w-full flex-col">
        <CounterpartyWorkspace
          initialCounterparties={counterpartiesResult.data}
          initialTotal={counterpartiesResult.total}
          apiKeys={apiKeysResult.data ?? []}
          apiBaseUrl={apiBaseUrl}
        />
      </div>
    );
  });
}
