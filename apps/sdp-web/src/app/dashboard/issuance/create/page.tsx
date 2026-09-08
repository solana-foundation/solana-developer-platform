import { Suspense } from "react";
import { createSdpApiClient } from "@/lib/sdp-api";
import { fetchPaymentsWallets } from "../../payments/payments-page.data";
import { IssuanceDraftForm } from "./issuance-draft-form";

export default async function CreateAssetPage() {
  const client = await createSdpApiClient();
  const result = await fetchPaymentsWallets(client.request, {
    view: "summary",
    includeBalances: false,
  });
  return (
    <Suspense>
      <IssuanceDraftForm
        wallets={result.data ?? []}
        walletsError={result.ok ? null : "Unable to load wallets. Reload to try again."}
      />
    </Suspense>
  );
}
