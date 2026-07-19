import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import { fetchActiveApiKeys, resolvePlaygroundApiBaseUrl } from "../../playground-api-data";
import { fetchCounterparties } from "./counterparty-page.data";
import { CounterpartyWorkspace } from "./counterparty-workspace";

export const dynamic = "force-dynamic";

interface CounterpartyPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function CounterpartyPage({ searchParams }: CounterpartyPageProps) {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const apiBaseUrl = resolvePlaygroundApiBaseUrl();
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const isPlayground =
    resolvedSearchParams?.tab === "playground" ||
    (Array.isArray(resolvedSearchParams?.tab) && resolvedSearchParams.tab[0] === "playground");

  return withDashboardPageTrace("dashboard.counterparty.page", async ({ trace, apiClient }) => {
    const counterpartiesPromise = trace.step("fetch_counterparties", () =>
      fetchCounterparties(apiClient.request)
    );
    const [counterpartiesResult, apiKeysResult] = isPlayground
      ? await Promise.all([
          counterpartiesPromise,
          trace.step("fetch_active_api_keys", () => fetchActiveApiKeys(apiClient.request)),
        ])
      : [await counterpartiesPromise, null];

    trace.log({
      ok: true,
      counterpartiesOk: counterpartiesResult.ok,
      counterpartiesCount: counterpartiesResult.data.length,
      counterpartiesTotal: counterpartiesResult.total,
      apiKeysOk: apiKeysResult?.ok ?? true,
      apiKeysCount: apiKeysResult?.data?.length ?? 0,
    });

    return (
      <div className="flex h-full min-h-0 w-full flex-col">
        <CounterpartyWorkspace
          initialCounterparties={counterpartiesResult.data}
          initialTotal={counterpartiesResult.total}
          apiKeys={apiKeysResult?.data ?? []}
          apiBaseUrl={apiBaseUrl}
        />
      </div>
    );
  });
}
