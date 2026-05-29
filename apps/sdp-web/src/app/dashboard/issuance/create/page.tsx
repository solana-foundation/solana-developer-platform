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
  const isDevnet = solanaNetwork !== "mainnet-beta";

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
