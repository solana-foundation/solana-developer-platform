import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import { projectHref } from "@/lib/dashboard-project-path";
import { paymentsPlaygroundHref } from "@/lib/payments-routes";
import {
  fetchCounterpartyDirectory,
  fetchProjectCounterpartyAccounts,
} from "./counterparty-page.data";
import { CounterpartyWorkspace } from "./counterparty-workspace.redesign";

async function CounterpartyPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }
  const { projectId } = await params;
  if ((await searchParams).tab === "playground") {
    // The contact list no longer has a playground tab; its endpoints moved into the Payments one.
    redirect(projectHref(projectId, paymentsPlaygroundHref("list-counterparties")));
  }

  return withDashboardPageTrace(
    "dashboard.counterparty.page",
    projectId,
    async ({ trace, apiClient }) => {
      const [directory, accounts] = await Promise.all([
        trace.step("fetch_counterparty_directory", () =>
          fetchCounterpartyDirectory(apiClient.request)
        ),
        trace.step("fetch_counterparty_accounts", () =>
          fetchProjectCounterpartyAccounts(apiClient.request)
        ),
      ]);

      trace.log({
        ok: true,
        counterpartiesOk: directory.ok,
        counterpartiesCount: directory.data.length,
        counterpartiesTotal: directory.total,
        accountsOk: accounts.ok,
        accountsCount: accounts.data.length,
        accountsTotal: accounts.total,
      });

      return (
        <CounterpartyWorkspace
          counterparties={directory.data}
          total={directory.total}
          directoryFailed={!directory.ok}
          accounts={accounts.data}
          accountsTotal={accounts.total}
          accountsFailed={!accounts.ok}
        />
      );
    }
  );
}

export default CounterpartyPage;
