"use client";

import type { CustodyWalletSummary } from "@sdp/types";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";
import { ApiPlaygroundShellSkeleton } from "@/components/api-playground-shell-skeleton";
import { DashboardWorkspaceTabShell } from "@/components/dashboard-workspace-tab-shell";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { getStoredApiKeySecret } from "@/lib/playground-api-keys";
import type { KnownCustodyProvider } from "./provider-catalog";
import { WalletsOverview } from "./wallets-overview";

const WalletsPlayground = dynamic(
  () => import("./wallets-playground").then((module) => module.WalletsPlayground),
  {
    loading: () => <ApiPlaygroundShellSkeleton />,
  }
);

interface WalletsApiKeyOption {
  id: string;
  name: string;
  keyPrefix: string;
  role: string;
  environment: string;
}

interface WalletsWorkspaceProps {
  apiBaseUrl: string | null;
  apiKeys: WalletsApiKeyOption[];
  connectedProviders: KnownCustodyProvider[];
  enabledProviders: KnownCustodyProvider[];
  configsError: string | null;
  wallets: CustodyWalletSummary[];
  walletsError: string | null;
}

export function WalletsWorkspace({
  apiBaseUrl,
  apiKeys,
  connectedProviders,
  enabledProviders,
  configsError,
  wallets,
  walletsError,
}: WalletsWorkspaceProps) {
  const router = useRouter();
  const { dashboardAccess, issuanceTab, selectedPlaygroundApiKeyId, setPlaygroundApiKeys } =
    useDashboardWorkspace();
  const isPlaygroundTab = issuanceTab === "playground";

  useEffect(() => {
    setPlaygroundApiKeys(apiKeys);
  }, [apiKeys, setPlaygroundApiKeys]);

  useEffect(() => {
    if (isPlaygroundTab) {
      return;
    }

    const preloadPlayground = () => {
      void import("./wallets-playground");
    };

    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      const idleId = window.requestIdleCallback(preloadPlayground);
      return () => window.cancelIdleCallback(idleId);
    }

    const timeoutId = globalThis.setTimeout(preloadPlayground, 600);
    return () => globalThis.clearTimeout(timeoutId);
  }, [isPlaygroundTab]);

  const selectedPlaygroundApiKey = useMemo(
    () => apiKeys.find((key) => key.id === selectedPlaygroundApiKeyId) ?? null,
    [apiKeys, selectedPlaygroundApiKeyId]
  );
  const selectedPlaygroundApiKeyPrefix = selectedPlaygroundApiKey?.keyPrefix ?? null;
  const playgroundApiKeyValue = useMemo(() => {
    if (!selectedPlaygroundApiKey) {
      return "";
    }

    const stored = getStoredApiKeySecret({
      apiKeyId: selectedPlaygroundApiKey.id,
      keyPrefix: selectedPlaygroundApiKeyPrefix,
    });

    return stored ?? "";
  }, [selectedPlaygroundApiKey, selectedPlaygroundApiKeyPrefix]);

  const openWalletSetup = (provider: KnownCustodyProvider | null) => {
    const params = new URLSearchParams();
    if (provider) {
      params.set("provider", provider);
    }

    const query = params.toString();
    router.push(`/dashboard/wallets/setup${query ? `?${query}` : ""}`);
  };

  return (
    <div className="h-full min-h-0 w-full">
      <DashboardWorkspaceTabShell
        disableOverviewInitialAnimation
        isPlaygroundTab={isPlaygroundTab}
        overviewClassName="space-y-6"
        overview={
          <WalletsOverview
            enabledProviders={enabledProviders}
            configsError={configsError}
            wallets={wallets}
            walletsError={walletsError}
            canManageCustody={dashboardAccess.capabilities.canManageCustody}
            onCreateWallet={openWalletSetup}
          />
        }
        playground={
          <WalletsPlayground
            apiBaseUrl={apiBaseUrl}
            apiKeyValue={playgroundApiKeyValue}
            connectedProviders={connectedProviders}
            configsError={configsError}
            hasActiveApiKeys={apiKeys.length > 0}
            wallets={wallets.map((wallet) => ({
              walletId: wallet.walletId,
              label: wallet.label,
              provider: wallet.provider ?? null,
              publicKey: wallet.publicKey,
            }))}
            walletsError={walletsError}
          />
        }
      />
    </div>
  );
}
