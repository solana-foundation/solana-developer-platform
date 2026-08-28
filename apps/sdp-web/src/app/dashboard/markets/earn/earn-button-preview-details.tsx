import type { EarnStrategy } from "@sdp/types";
import { useLocale, useTranslations } from "@/i18n/provider";
import { formatProviderApy } from "./earn-market-presentation";

export function EarnButtonPreviewDetails({ strategy }: { strategy: EarnStrategy }) {
  const t = useTranslations();
  const locale = useLocale();
  return (
    <div>
      <p className="text-xs text-tertiary">{t("DashboardMarkets.earnProgram.previewStrategy")}</p>
      <p className="mt-1 line-clamp-2 text-lg font-medium tracking-tight text-primary">
        {strategy.name}
      </p>
      <p className="mt-2 text-sm text-secondary tabular-nums">
        {t("DashboardMarkets.earnProgram.previewRate", {
          apy: formatProviderApy(strategy.currentApy, locale),
        })}
      </p>
    </div>
  );
}
