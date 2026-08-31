import type { EarnButtonStyle, EarnStrategy } from "@sdp/types";
import { BatteryFullIcon, SignalHighIcon, WifiHighIcon } from "lucide-react";
import { useTranslations } from "@/i18n/provider";
import { EarnButtonPreviewDetails } from "./earn-button-preview-details";
import { EarnSavingsCardPreview } from "./earn-savings-preview";

export function EarnButtonIosPreview({
  accentColor,
  strategy,
  style,
}: {
  accentColor: string;
  strategy: EarnStrategy;
  style: EarnButtonStyle;
}) {
  const t = useTranslations();
  return (
    <figure aria-label={t("DashboardMarkets.earnProgram.iosPreview")} className="w-full">
      <figcaption className="sr-only">{t("DashboardMarkets.earnProgram.iosPreview")}</figcaption>
      <div className="mx-auto w-full max-w-[16.5rem] rounded-[3.15rem] bg-[#171719] p-[0.42rem] shadow-[0_24px_60px_rgba(0,0,0,0.24)] ring-1 ring-white/10">
        <div className="relative aspect-[390/844] overflow-hidden rounded-[2.75rem] bg-surface-raised">
          <div className="relative flex h-8 items-center justify-between px-5 pt-1 text-[9px] font-semibold text-primary">
            <span aria-hidden="true">9:41</span>
            <div
              aria-hidden="true"
              className="absolute top-1 left-1/2 h-5 w-[4.8rem] -translate-x-1/2 rounded-full bg-[#0d0d0e]"
            />
            <span aria-hidden="true" className="flex items-center gap-1">
              <SignalHighIcon className="size-2.5" />
              <WifiHighIcon className="size-2.5" />
              <BatteryFullIcon className="size-3" />
            </span>
          </div>

          <div className="flex h-[calc(100%-2rem)] flex-col px-4 pb-5">
            <div className="flex items-center justify-between border-b border-border-subtle py-3">
              <p className="text-sm font-medium text-primary">
                {t("DashboardMarkets.earnProgram.previewProduct")}
              </p>
              <span aria-hidden="true" className="size-7 rounded-full bg-fill-strong" />
            </div>

            <div className="flex flex-1 flex-col pt-4 pb-4">
              <div className="rounded-2xl border border-border-default bg-fill-subtle p-4 shadow-sm">
                <EarnSavingsCardPreview
                  accentColor={accentColor}
                  compact
                  header={<EarnButtonPreviewDetails strategy={strategy} />}
                  style={style}
                />
              </div>
            </div>

            <div aria-hidden="true" className="mx-auto h-1 w-24 rounded-full bg-primary/80" />
          </div>
        </div>
      </div>
    </figure>
  );
}
