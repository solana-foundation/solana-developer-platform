import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import { fetchCounterpartyDetail, fetchCounterpartyPayouts } from "../counterparty-detail.data";
import { CounterpartyDetailWorkspace } from "../counterparty-detail-workspace.redesign";

async function CounterpartyDetailRoute({
  params,
}: {
  params: Promise<{ counterpartyId: string }>;
}) {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const { counterpartyId } = await params;

  return withDashboardPageTrace(
    "dashboard.counterparty.detail.page",
    async ({ trace, apiClient }) => {
      const [detail, payouts] = await Promise.all([
        trace.step("fetch_counterparty_detail", () =>
          fetchCounterpartyDetail(apiClient.request, counterpartyId)
        ),
        trace.step("fetch_counterparty_payouts", () =>
          fetchCounterpartyPayouts(apiClient.request, counterpartyId)
        ),
      ]);

      trace.log({
        ok: detail.counterparty !== null,
        accounts: detail.accounts.length,
        accountsFailed: detail.accountsFailed,
        transfers: detail.transfers.length,
        transfersFailed: detail.transfersFailed,
        payouts: payouts.data.length,
        payoutsTotal: payouts.total,
        payoutsFailed: !payouts.ok,
      });

      if (!detail.counterparty) {
        redirect("/dashboard/payments/counterparty");
      }

      return (
        <div className="flex h-full min-h-0 w-full flex-col">
          <CounterpartyDetailWorkspace
            counterparty={detail.counterparty}
            initialAccounts={detail.accounts}
            accountsTotal={detail.accountsTotal}
            accountsFailed={detail.accountsFailed}
            initialTransfers={detail.transfers}
            transfersFailed={detail.transfersFailed}
            payouts={payouts.data}
            payoutsTotal={payouts.total}
            payoutsFailed={!payouts.ok}
          />
        </div>
      );
    }
  );
}

export default CounterpartyDetailRoute;
