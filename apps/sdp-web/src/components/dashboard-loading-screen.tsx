"use client";

import type { ComponentProps } from "react";
import { enabledTransactionModules } from "@/app/dashboard/[projectId]/payments/transactions/transaction-modules";
import { getDashboardPageConfig } from "@/components/dashboard-header";
import { resolvePageLoadingComponent } from "@/components/dashboard-page-loading";
import { FullscreenLoadingIndicator } from "@/components/fullscreen-loading-indicator";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { DashboardFlags } from "@/flags/dashboard";
import { useTranslations } from "@/i18n/provider";
import { resolveDashboardLoadingRoute } from "@/lib/dashboard-navigation-loading";
import { isNewDesignPage } from "@/lib/design-modules";
import { useDashboardPathname } from "@/lib/use-dashboard-project";

// Preparation, scope reconciliation, and client auth all paint the same destination.
export function DashboardLoadingScreen({
  pathname,
  flags,
  ...props
}: {
  pathname: string;
  flags?: DashboardFlags;
} & Omit<
  ComponentProps<typeof FullscreenLoadingIndicator>,
  "children" | "contentWidthClass" | "hideTitle"
>) {
  const t = useTranslations();
  const path = pathname.split(/[?#]/)[0];
  const route = resolveDashboardLoadingRoute(path) ?? "home";
  const newDesignPage = isNewDesignPage(path, flags);
  const PageLoading = resolvePageLoadingComponent(route, newDesignPage);
  const config = getDashboardPageConfig(
    path,
    t,
    flags?.assetProfiles ?? false,
    flags?.privateChannels ?? false,
    flags === undefined ? [] : enabledTransactionModules(flags),
    flags?.custody,
    flags?.payments,
    flags?.policies,
    flags?.newDesign ?? false,
    flags?.newDesignModules
  );

  return (
    <FullscreenLoadingIndicator
      {...props}
      contentWidthClass={config.contentWidthClass ?? "max-w-5xl"}
      hideTitle={config.hideTitle}
      newDesign={flags?.newDesign ?? false}
    >
      <PageLoading assetProfilesEnabled={flags?.assetProfiles} />
    </FullscreenLoadingIndicator>
  );
}

export function DashboardScopeLoadingScreen() {
  const pathname = useDashboardPathname();
  const { flags, isSidebarOpen } = useDashboardWorkspace();
  return (
    <DashboardLoadingScreen
      pathname={pathname}
      flags={flags}
      isSidebarOpen={isSidebarOpen}
      allowDelayedReload
    />
  );
}
