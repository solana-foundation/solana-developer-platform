import { notFound } from "next/navigation";
import { assetProfiles } from "@/flags";
import { getTranslations } from "@/i18n/server";
import { createSdpApiClient } from "@/lib/sdp-api";
import { fetchPaymentsWallets } from "../../payments/payments-page.data";
import { IssuanceDraftFlow } from "./issuance-draft-flow.redesign";

interface CreateDraftPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * A new draft on the new design: the flow, with the project's wallets to hold its keys.
 * `?draft=` opens a draft kept in the browser instead of a fresh one.
 */
export default async function CreateDraftPage({ searchParams }: CreateDraftPageProps) {
  const [t, resolvedSearchParams] = await Promise.all([
    getTranslations(),
    searchParams ?? Promise.resolve(undefined),
  ]);
  const resume = resolvedSearchParams?.draft;
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
      resumeId={typeof resume === "string" && resume ? resume : null}
    />
  );
}
