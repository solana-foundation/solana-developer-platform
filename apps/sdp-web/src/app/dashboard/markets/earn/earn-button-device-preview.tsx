"use client";

import type { EarnButtonStyle, EarnStrategy } from "@sdp/types";
import { MonitorIcon, SmartphoneIcon } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { EarnButtonIosPreview } from "./earn-button-ios-preview";
import { EarnButtonWebPreview } from "./earn-button-web-preview";

type PreviewDevice = "ios" | "web";

export function EarnButtonDevicePreview({
  accentColor,
  strategy,
  style,
}: {
  accentColor: string;
  strategy: EarnStrategy;
  style: EarnButtonStyle;
}) {
  const t = useTranslations();
  const [device, setDevice] = useState<PreviewDevice>("ios");
  const options = [
    {
      value: "ios" as const,
      label: t("DashboardMarkets.earnProgram.previewIos"),
      icon: SmartphoneIcon,
    },
    {
      value: "web" as const,
      label: t("DashboardMarkets.earnProgram.previewWeb"),
      icon: MonitorIcon,
    },
  ];

  return (
    <section className="border-t border-border-subtle pt-6">
      <fieldset className="mx-auto grid w-full max-w-xs grid-cols-2 gap-1 rounded-full bg-fill-subtle p-1">
        <legend className="sr-only">{t("DashboardMarkets.earnProgram.previewDevice")}</legend>
        {options.map((option) => {
          const selected = option.value === device;
          const Icon = option.icon;
          return (
            <button
              aria-pressed={selected}
              className={cn(
                "flex h-9 items-center justify-center gap-2 rounded-full px-4 text-xs font-medium transition-colors",
                selected
                  ? "bg-surface-raised text-primary shadow-sm"
                  : "text-secondary hover:text-primary"
              )}
              key={option.value}
              onClick={() => setDevice(option.value)}
              type="button"
            >
              <Icon aria-hidden="true" className="size-3.5" />
              {option.label}
            </button>
          );
        })}
      </fieldset>

      <div className="mt-5 flex min-h-[36rem] items-center justify-center overflow-hidden rounded-2xl border border-border-default bg-fill-subtle px-4 py-6 sm:px-8">
        {device === "ios" ? (
          <EarnButtonIosPreview accentColor={accentColor} strategy={strategy} style={style} />
        ) : (
          <EarnButtonWebPreview accentColor={accentColor} strategy={strategy} style={style} />
        )}
      </div>
    </section>
  );
}
