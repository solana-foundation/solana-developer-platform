import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { Callout } from "@/components/ui/callout";
import { getTranslations } from "@/i18n/server";

/**
 * Shown when the trade could not be read, as distinct from not existing.
 *
 * Rendering an outage as a 404 tells someone their trade is gone when it is
 * sitting there — and a DvP trade holds both parties' money in escrow, so
 * "gone" is the worst possible wrong answer.
 */
/**
 * @param message - What went wrong, when the API said. A 200 whose body held no
 *   trade produces no message at all, and that case still has to render as a
 *   failure rather than falling through to a 404.
 */
export async function DvpTradeLoadError({ message }: { message?: string | null }) {
  const t = await getTranslations();
  return (
    <DashboardWorkspaceOverviewPanel className="px-4 pt-6 pb-8 md:px-8 xl:px-16">
      <div className="mx-auto w-full max-w-[63rem]">
        <Callout live title={t("DashboardMarkets.dvp.loadErrorTitle")} variant="danger">
          <p>{t("DashboardMarkets.dvp.loadErrorDescription")}</p>
          <p className="mt-2 font-mono text-xs opacity-80">
            {message ?? t("DashboardMarkets.dvp.loadErrorUnexpected")}
          </p>
        </Callout>
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
