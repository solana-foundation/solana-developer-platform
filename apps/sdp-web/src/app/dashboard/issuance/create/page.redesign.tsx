import { notFound } from "next/navigation";
import { assetProfiles } from "@/flags";
import { getTranslations } from "@/i18n/server";
import { createSdpApiClient } from "@/lib/sdp-api";
import { fetchPaymentsWallets } from "../../payments/payments-page.data";
import { IssuanceDraftFlow } from "./issuance-draft-flow.redesign";

/** A new draft on the new design: the flow, with the project's wallets to hold its keys. */
export default async function CreateDraftPage() {
  const t = await getTranslations();
  if (!(await assetProfiles())) notFound();
  const client = await createSdpApiClient();
  const result = await fetchPaymentsWallets(client.request, {
    view: "summary",
    includeBalances: false,
  });
  return (
    <IssuanceDraftFlow
      wallets={result.data ?? []}
      walletsError={result.ok ? null : t("DashboardIssuance.draftForm.walletsError")}
    />
  );
}
