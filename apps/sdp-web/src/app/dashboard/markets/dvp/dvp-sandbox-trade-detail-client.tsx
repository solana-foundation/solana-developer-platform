"use client";

import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { Callout } from "@/components/ui/callout";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { useMarketsSandbox } from "../markets-sandbox-store";
import { DvpTradeDetailWorkspace } from "./dvp-trade-detail-workspace";

export function DvpSandboxTradeDetailClient({ tradeId }: { tradeId: string }) {
  const t = useTranslations();
  const { selectedProjectId } = useDashboardWorkspace();
  const { state } = useMarketsSandbox(selectedProjectId);
  const trade = state.dvpTrades.find((candidate) => candidate.id === tradeId);
  return trade ? (
    <DvpTradeDetailWorkspace cluster="mainnet-beta" trade={trade} />
  ) : (
    <DashboardWorkspaceOverviewPanel className="px-4 pt-6 pb-8 md:px-8 xl:px-16">
      <div className="mx-auto w-full max-w-[63rem]">
        <Callout live title={t("DashboardMarkets.dvp.loadErrorTitle")} variant="danger">
          {t("DashboardMarkets.sandbox.tradeMissing")}
        </Callout>
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
