import { auth } from "@clerk/nextjs/server";
import { notFound, redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import { fetchCounterpartyDetail } from "../counterparty-detail.data";
import { CounterpartyDetailWorkspace } from "../counterparty-detail-workspace";

export const dynamic = "force-dynamic";

export default async function CounterpartyDetailRoute({
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
      const detail = await trace.step("fetch_counterparty_detail", () =>
        fetchCounterpartyDetail(apiClient.request, counterpartyId)
      );

      trace.log({
        ok: detail.counterparty !== null,
        accounts: detail.accounts.length,
        transfers: detail.transfers.length,
      });

      if (!detail.counterparty) {
        notFound();
      }

      return (
        <div className="flex h-full min-h-0 w-full flex-col">
          <CounterpartyDetailWorkspace
            counterparty={detail.counterparty}
            initialAccounts={detail.accounts}
            initialTransfers={detail.transfers}
          />
        </div>
      );
    }
  );
}
