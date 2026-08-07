import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getTranslations } from "@/i18n/server";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { createTimedTrace } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";
import { fetchPaymentsAggregate } from "../payments/payments-page.data";
import { HoldingsWorkspace } from "./holdings-workspace";

export default async function TokenHoldingsPage() {
  const t = await getTranslations();
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    return null;
  }

  const trace = createTimedTrace("dashboard.tokens.page");
  const apiClient = await trace.step("create_sdp_api_client", () =>
    createSdpApiClient(trace.childContext("dashboard.tokens.api"))
  );
  // Same aggregate the home page already reads, so this page needs no new endpoint
  // and cannot disagree with the card it was opened from.
  const aggregateResult = await trace.step("fetch_payments_aggregate", () =>
    fetchPaymentsAggregate(apiClient.request)
  );

  trace.log({ ok: aggregateResult.ok, hasAggregate: Boolean(aggregateResult.data?.balances) });

  if (!aggregateResult.ok && !aggregateResult.data) {
    return (
      <p className="py-10 text-sm text-destructive-strong">
        {t("Shared.homeWorkspace.holdingsUnavailable")}
      </p>
    );
  }

  return <HoldingsWorkspace balances={aggregateResult.data?.balances ?? []} />;
}
