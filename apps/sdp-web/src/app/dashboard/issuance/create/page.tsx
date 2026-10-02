import { notFound } from "next/navigation";
import { Suspense } from "react";
import { assetProfiles } from "@/flags";
import { withLegacyDesign } from "@/flags/new-design";
import { getTranslations } from "@/i18n/server";
import { createSdpApiClient } from "@/lib/sdp-api";
import { fetchPaymentsWallets } from "../../payments/payments-page.data";
import { IssuanceDraftForm } from "./issuance-draft-form";
import CreateDraftPage from "./page.redesign";

async function CreateAssetPage() {
  const t = await getTranslations();
  if (!(await assetProfiles())) notFound();
  const client = await createSdpApiClient();
  const result = await fetchPaymentsWallets(client.request, {
    view: "summary",
    includeBalances: false,
  });
  return (
    <Suspense>
      <IssuanceDraftForm
        wallets={result.data ?? []}
        walletsError={result.ok ? null : t("DashboardIssuance.draftForm.walletsError")}
      />
    </Suspense>
  );
}

export default withLegacyDesign(CreateDraftPage, CreateAssetPage, "issuance");
