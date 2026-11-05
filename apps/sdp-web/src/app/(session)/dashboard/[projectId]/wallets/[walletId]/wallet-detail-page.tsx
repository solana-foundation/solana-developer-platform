import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { issuance } from "@/flags";
import { WalletDetailView } from "./wallet-detail-view";

/** One wallet's page. Everything on it is read in the browser. */
export async function WalletDetailPage({ params }: { params: Promise<{ walletId: string }> }) {
  const [{ orgId }, { walletId }, issuanceEnabled] = await Promise.all([
    auth(),
    params,
    issuance(),
  ]);
  if (!orgId) {
    redirect("/dashboard");
  }

  return (
    <WalletDetailView walletId={decodeURIComponent(walletId)} issuanceEnabled={issuanceEnabled} />
  );
}
