import { WalletDetailPage } from "./wallet-detail-page";

interface WalletDetailRouteProps {
  params: Promise<{
    walletId: string;
  }>;
}

/**
 * One wallet's page.
 *
 * @param props - The route params, carrying the wallet to read.
 * @returns The wallet's page.
 */
export default async function WalletDetailRoute({ params }: WalletDetailRouteProps) {
  return WalletDetailPage({ params });
}
