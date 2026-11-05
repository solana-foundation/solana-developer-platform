"use client";

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
import { useTranslations } from "@/i18n/provider";
import { useDashboardTab } from "@/lib/dashboard-url-state";
import { useConnectedCustodyProviders, useCustodyWallets } from "./custody-reads";
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

export function WalletsWorkspace({ apiBaseUrl }: { apiBaseUrl: string | null }) {
  const t = useTranslations();
  const { dashboardAccess } = useDashboardWorkspace();
  const walletsRead = useCustodyWallets();
  const walletsError =
    walletsRead.error === undefined ? null : t("DashboardCustody.unableToLoadWallets");
  const providersRead = useConnectedCustodyProviders();
  const configsError =
    providersRead.error === undefined ? null : t("DashboardCustody.unableToLoadWalletProviders");
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
                  walletsRead={walletsRead}
                  canManageCustody={dashboardAccess.capabilities.canManageCustody}
                />
              </div>
            ),
          },
          {
            id: "playground",
            className: dashboardWorkspacePlaygroundPanelClassName,
            content:
              (walletsRead.data === undefined && walletsError === null) ||
              (providersRead.data === undefined && configsError === null) ? (
                <ApiPlaygroundShellSkeleton />
              ) : (
                <WalletsPlayground
                  apiBaseUrl={apiBaseUrl}
                  // A failed read leaves the examples without providers; the playground names it.
                  connectedProviders={providersRead.data ?? []}
                  configsError={configsError}
                  // A failed read leaves the examples without wallets; the playground names the failure.
                  wallets={(walletsRead.data ?? []).map((wallet) => ({
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
