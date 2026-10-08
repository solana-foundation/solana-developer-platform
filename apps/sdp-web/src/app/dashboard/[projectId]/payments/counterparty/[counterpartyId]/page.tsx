import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { withLegacyDesign } from "@/flags/new-design";
import { isRampsEnabled } from "@/flags/ramps";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import { requestProjectHref } from "@/lib/sdp-api";
import { fetchCounterpartyDetail } from "../counterparty-detail.data";
import { CounterpartyDetailWorkspace } from "../counterparty-detail-workspace";
import RedesignCounterpartyDetailRoute from "./page.redesign";

export const dynamic = "force-dynamic";

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
      const [detail, rampsEnabled] = await Promise.all([
        trace.step("fetch_counterparty_detail", () =>
          fetchCounterpartyDetail(apiClient.request, counterpartyId)
        ),
        isRampsEnabled(),
      ]);

      trace.log({
        ok: detail.counterparty !== null,
        accounts: detail.accounts.length,
        transfers: detail.transfers.length,
      });

      if (!detail.counterparty) {
        redirect(await requestProjectHref("/dashboard/payments/counterparty"));
      }

      return (
        <div className="flex h-full min-h-0 w-full flex-col">
          <CounterpartyDetailWorkspace
            counterparty={detail.counterparty}
            initialAccounts={detail.accounts}
            initialTransfers={detail.transfers}
            rampsEnabled={rampsEnabled}
          />
        </div>
      );
    }
  );
}

export default withLegacyDesign(
  RedesignCounterpartyDetailRoute,
  CounterpartyDetailRoute,
  "contacts"
);
