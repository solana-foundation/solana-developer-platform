"use client";

import type { CustodyWalletSummary } from "@sdp/types/custody";
import { cn } from "@sdp/ui/cn";
import dynamic from "next/dynamic";
import { useEffect } from "react";
import { ApiPlaygroundShellSkeleton } from "@/components/api-playground-shell-skeleton";
import {
  dashboardWorkspaceOverviewPanelClassName,
  dashboardWorkspacePlaygroundPanelClassName,
} from "@/components/dashboard-workspace-panel";
import { DashboardWorkspaceTabShell } from "@/components/dashboard-workspace-tab-shell";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useDashboardTab } from "@/lib/dashboard-url-state";
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

interface WalletsWorkspaceProps {
  apiBaseUrl: string | null;
  connectedProviders: KnownCustodyProvider[];
  configsError: string | null;
  wallets: CustodyWalletSummary[];
  walletsError: string | null;
}

export function WalletsWorkspace({
  apiBaseUrl,
  connectedProviders,
  configsError,
  wallets,
  walletsError,
}: WalletsWorkspaceProps) {
  const { dashboardAccess } = useDashboardWorkspace();
  const isPlaygroundTab = useDashboardTab() === "playground";

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
                  configsError={configsError}
                  wallets={wallets}
                  walletsError={walletsError}
                  canManageCustody={dashboardAccess.capabilities.canManageCustody}
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
                connectedProviders={connectedProviders}
                configsError={configsError}
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
