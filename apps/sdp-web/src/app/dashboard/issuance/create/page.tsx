import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { createSdpApiClient } from "@/lib/sdp-api";
import { fetchPaymentsWallets } from "../../payments/payments-page.data";
import { CreateTokenFlow } from "./create-token-flow";

export default async function CreateTokenPage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const apiClient = await createSdpApiClient();
  const signerWalletsResult = await fetchPaymentsWallets(apiClient.request, { view: "summary" });

  const solanaNetwork = process.env.NEXT_PUBLIC_SOLANA_NETWORK ?? "devnet";
  // Confidential transfers are devnet-only on the API (SOLANA_NETWORK === "devnet"),
  // so keep this gate identical to avoid showing a toggle that 400s on submit.
  const isDevnet = solanaNetwork === "devnet";

  return (
    <CreateTokenFlow
      signerWallets={signerWalletsResult.data ?? []}
      signerWalletsError={
        signerWalletsResult.ok
          ? null
          : `Wallet API ${signerWalletsResult.status ?? "unavailable"}: ${signerWalletsResult.error ?? "Unknown error"}`
      }
      isDevnet={isDevnet}
    />
  );
}
