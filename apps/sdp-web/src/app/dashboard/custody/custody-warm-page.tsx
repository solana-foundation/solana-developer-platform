"use client";

import { WalletsPageSkeleton } from "@/app/dashboard/wallets/wallets-page-skeleton";
import { useDashboardWarmSnapshot } from "@/lib/use-dashboard-warm-snapshot";
import { isKnownCustodyProvider, type KnownCustodyProvider } from "./provider-catalog";
import { WalletsWorkspace } from "./wallets-workspace";

interface CustodyWarmPageProps {
  apiBaseUrl: string | null;
}

function deriveWalletProviders(wallets: Array<{ provider?: string | null }>) {
  const providers = new Set<KnownCustodyProvider>();

  for (const wallet of wallets) {
    if (wallet.provider && isKnownCustodyProvider(wallet.provider)) {
      providers.add(wallet.provider);
    }
  }

  return [...providers];
}

export function CustodyWarmPage({ apiBaseUrl }: CustodyWarmPageProps) {
  const { data: snapshot, isLoading } = useDashboardWarmSnapshot({ revalidate: false });
  const wallets = snapshot?.wallets.data ?? [];

  if (!snapshot && isLoading) {
    return <WalletsPageSkeleton />;
  }

  const derivedProviders = deriveWalletProviders(wallets);
  const providerStatus = snapshot?.walletProviderStatus.data;
  const connectedProviders =
    providerStatus && providerStatus.connectedProviders.length > 0
      ? providerStatus.connectedProviders
      : derivedProviders;
  const enabledProviders =
    providerStatus && providerStatus.enabledProviders.length > 0
      ? providerStatus.enabledProviders
      : connectedProviders;

  return (
    <WalletsWorkspace
      apiBaseUrl={apiBaseUrl}
      apiKeys={snapshot?.apiKeys.data.filter((apiKey) => apiKey.status === "active") ?? []}
      connectedProviders={connectedProviders}
      enabledProviders={enabledProviders}
      configsError={providerStatus?.configsError ?? snapshot?.walletProviderStatus.error ?? null}
      wallets={wallets}
      walletsError={snapshot?.wallets.error ?? null}
    />
  );
}
