"use client";

import { Button } from "@sdp/ui/button";
import { Callout } from "@sdp/ui/callout";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { useTranslations } from "@/i18n/provider";

/**
 * Shown when the trade could not be read, as distinct from not existing.
 *
 * @param message - What went wrong, when the API said. A 200 whose body held no
 *   trade produces no message at all, and that case still has to render as a
 *   failure rather than falling through to a 404.
 */
export function DvpTradeLoadError({
  message,
  onRetry,
}: {
  message: string | null;
  onRetry: () => void;
}) {
  const t = useTranslations();
  return (
    <DashboardWorkspaceOverviewPanel className="px-4 pt-6 pb-8 md:px-8 xl:px-16">
      <div className="mx-auto w-full max-w-[63rem]">
        <Callout live title={t("DashboardMarkets.dvp.loadErrorTitle")} variant="danger">
          <p>{t("DashboardMarkets.dvp.loadErrorDescription")}</p>
          <p className="mt-2 font-mono text-xs opacity-80">
            {message ?? t("DashboardMarkets.dvp.loadErrorUnexpected")}
          </p>
          <Button className="mt-3" onClick={onRetry} size="sm" type="button" variant="secondary">
            {t("DashboardMarkets.dvp.retry")}
          </Button>
        </Callout>
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
