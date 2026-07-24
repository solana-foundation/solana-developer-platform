import { auth } from "@clerk/nextjs/server";
import type { PaymentsDashboardWallet } from "@sdp/types";
import { notFound, redirect } from "next/navigation";
import { assetProfiles } from "@/flags";
import { getTranslations } from "@/i18n/server";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { createSdpApiClient } from "@/lib/sdp-api";
import { fetchPaymentsWallets } from "../../payments/payments-page.data";
import { IssuanceDraftWizard } from "./issuance-draft-wizard";

export default async function CreateAssetPage() {
  if (!(await assetProfiles())) {
    notFound();
  }

  const [t, { userId, orgId }] = await Promise.all([getTranslations(), auth()]);
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  // Signer wallets power the "Signing wallet" selector on the Asset details
  // step — same source and shape the token action forms use.
  let signerWallets: PaymentsDashboardWallet[] = [];
  let signerWalletsError: string | null = null;
  try {
    const apiClient = await createSdpApiClient();
    const result = await fetchPaymentsWallets(apiClient.request, { view: "summary" });
    signerWallets = result.data ?? [];
    signerWalletsError = result.ok
      ? null
      : t("DashboardIssuance.errors.apiRequestFailed", {
          resource: t("DashboardIssuance.errors.walletResource"),
          status: result.status ?? t("DashboardIssuance.errors.unavailable"),
          error: result.error ?? t("DashboardIssuance.errors.unknown"),
        });
  } catch (error) {
    signerWalletsError =
      error instanceof Error
        ? error.message
        : t("DashboardIssuance.errors.unableToLoadSignerWallets");
  }

  return (
    <IssuanceDraftWizard signerWallets={signerWallets} signerWalletsError={signerWalletsError} />
  );
}
