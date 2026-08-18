"use client";

import type { CustodyWalletSummary } from "@sdp/types";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";
import { ApiPlaygroundShellSkeleton } from "@/components/api-playground-shell-skeleton";
import {
  dashboardWorkspaceOverviewPanelClassName,
  dashboardWorkspacePlaygroundPanelClassName,
} from "@/components/dashboard-workspace-panel";
import { DashboardWorkspaceTabShell } from "@/components/dashboard-workspace-tab-shell";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useDashboardTab } from "@/lib/dashboard-url-state";
import { getStoredApiKeySecret } from "@/lib/playground-api-keys";
import { cn } from "@/lib/utils";
import type { KnownCustodyProvider } from "./provider-catalog";
import { WalletsOverview } from "./wallets-overview";

const WalletsPlayground = dynamic(
  () => import("./wallets-playground").then((module) => module.WalletsPlayground),
  {
    loading: () => (
      <div aria-busy="true" className="contents" data-wallet-panel="playground-pending">
        <ApiPlaygroundShellSkeleton />
      </div>
    ),
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
  showConnectionsLink: boolean;
  wallets: CustodyWalletSummary[];
  walletsError: string | null;
}

export function WalletsWorkspace({
  apiBaseUrl,
  apiKeys,
  connectedProviders,
  enabledProviders,
  configsError,
  showConnectionsLink,
  wallets,
  walletsError,
}: WalletsWorkspaceProps) {
  const router = useRouter();
  const { dashboardAccess, selectedPlaygroundApiKeyId, setPlaygroundApiKeys } =
    useDashboardWorkspace();
  const isPlaygroundTab = useDashboardTab() === "playground";

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
    <div className="h-full min-h-0 w-full" data-wallet-root>
      <DashboardWorkspaceTabShell
        panels={[
          {
            id: "overview",
            className: cn(dashboardWorkspaceOverviewPanelClassName, "space-y-6"),
            disableInitialAnimation: true,
            content: (
              <div className="contents" data-wallet-panel="overview">
                <WalletsOverview
                  enabledProviders={enabledProviders}
                  configsError={configsError}
                  showConnectionsLink={showConnectionsLink}
                  wallets={wallets}
                  walletsError={walletsError}
                  canManageCustody={dashboardAccess.capabilities.canManageCustody}
                  onCreateWallet={openWalletSetup}
                />
              </div>
            ),
          },
          {
            id: "playground",
            className: dashboardWorkspacePlaygroundPanelClassName,
            content: (
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
            ),
          },
        ]}
      />
    </div>
  );
}
