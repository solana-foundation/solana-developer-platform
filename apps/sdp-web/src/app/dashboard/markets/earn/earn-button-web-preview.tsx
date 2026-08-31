import type { EarnButtonStyle, EarnStrategy } from "@sdp/types";
import { LockKeyholeIcon } from "lucide-react";
import { useTranslations } from "@/i18n/provider";
import { EarnButtonPreviewDetails } from "./earn-button-preview-details";
import { EarnSavingsCardPreview } from "./earn-savings-preview";

export function EarnButtonWebPreview({
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
    <figure aria-label={t("DashboardMarkets.earnProgram.webPreview")} className="w-full">
      <figcaption className="sr-only">{t("DashboardMarkets.earnProgram.webPreview")}</figcaption>
      <div className="mx-auto w-full max-w-4xl overflow-hidden rounded-xl border border-border-default bg-surface-raised shadow-[0_24px_60px_rgba(0,0,0,0.16)]">
        <div className="grid h-11 grid-cols-[1fr_minmax(10rem,22rem)_1fr] items-center gap-4 border-b border-border-subtle bg-fill-subtle px-4">
          <span aria-hidden="true" className="flex gap-1.5">
            <span className="size-2.5 rounded-full bg-fill-strong" />
            <span className="size-2.5 rounded-full bg-fill-strong" />
            <span className="size-2.5 rounded-full bg-fill-strong" />
          </span>
          <div className="flex min-w-0 items-center justify-center gap-1.5 rounded-md border border-border-subtle bg-surface-raised px-3 py-1.5 text-[10px] text-tertiary">
            <LockKeyholeIcon aria-hidden="true" className="size-2.5 shrink-0" />
            <span className="truncate">{t("DashboardMarkets.earnProgram.previewUrl")}</span>
          </div>
          <span />
        </div>

        <div className="flex min-h-[25rem] flex-col bg-surface-raised">
          <div className="flex h-12 items-center justify-between border-b border-border-subtle px-5">
            <p className="text-xs font-medium text-primary">
              {t("DashboardMarkets.earnProgram.previewProduct")}
            </p>
            <span aria-hidden="true" className="size-7 rounded-full bg-fill-strong" />
          </div>
          <div className="grid flex-1 place-items-center bg-fill-subtle p-6 sm:p-8">
            <div className="w-full max-w-md rounded-2xl border border-border-default bg-surface-raised p-6 shadow-sm">
              <EarnSavingsCardPreview
                accentColor={accentColor}
                header={<EarnButtonPreviewDetails strategy={strategy} />}
                style={style}
              />
            </div>
          </div>
        </div>
      </div>
    </figure>
  );
}
