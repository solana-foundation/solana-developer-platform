import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import {
  fetchCounterpartyDirectory,
  fetchProjectCounterpartyAccounts,
} from "./counterparty-page.data";
import { CounterpartyWorkspace } from "./counterparty-workspace";

export const dynamic = "force-dynamic";

export default async function CounterpartyPage() {
  const { orgId } = await auth();
  if (!orgId) {
    redirect("/dashboard");
  }

  return withDashboardPageTrace("dashboard.counterparty.page", async ({ trace, apiClient }) => {
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
  });
}
