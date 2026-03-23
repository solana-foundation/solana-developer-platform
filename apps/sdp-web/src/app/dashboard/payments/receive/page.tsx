import { getAuthEntryPath } from "@/lib/auth-entry";
import { createSdpApiClient } from "@/lib/sdp-api";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { PaymentsActionPage } from "../payments-action-page";
import { fetchPaymentsIssuedTokenSymbols } from "../payments-page.data";

export default async function PaymentsReceivePage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const apiClient = await createSdpApiClient();
  const issuedTokenSymbolsResult = await fetchPaymentsIssuedTokenSymbols(apiClient.request);
  const issuedTokenSymbolsByMint = Object.fromEntries(
    (issuedTokenSymbolsResult.data ?? []).map((token) => [token.mintAddress, token.symbol])
  );

  return (
    <PaymentsActionPage
      mode="receive"
      wallets={[]}
      walletsError={null}
      issuedTokenSymbolsByMint={issuedTokenSymbolsByMint}
    />
  );
}
