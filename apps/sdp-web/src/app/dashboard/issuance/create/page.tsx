import { auth } from "@clerk/nextjs/server";
import type { PaymentsDashboardWallet } from "@sdp/types";
import { notFound, redirect } from "next/navigation";
import { isAssetProfilesUiEnabled } from "@/lib/asset-profiles-feature";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { createSdpApiClient } from "@/lib/sdp-api";
import { fetchPaymentsWallets } from "../../payments/payments-page.data";
import { IssuanceDraftWizard } from "./issuance-draft-wizard";

export default async function CreateAssetPage() {
  if (!isAssetProfilesUiEnabled()) {
    notFound();
  }

  const { userId, orgId } = await auth();
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
      : `Wallet API ${result.status ?? "unavailable"}: ${result.error ?? "Unknown error"}`;
  } catch (error) {
    signerWalletsError = error instanceof Error ? error.message : "Unable to load signer wallets.";
  }

  return (
    <IssuanceDraftWizard signerWallets={signerWallets} signerWalletsError={signerWalletsError} />
  );
}
