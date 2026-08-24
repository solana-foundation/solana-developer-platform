"use client";

import type { EarnButtonStyle } from "@sdp/types";
import { PaletteIcon } from "lucide-react";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import {
  EARN_BUTTON_ACCENT_COLOR_OPTIONS,
  EARN_BUTTON_STYLE_OPTIONS,
} from "./earn-button-style-options";

export function EarnButtonAppearanceControls({
  accentColor,
  onAccentColorChange,
  onStyleChange,
  style,
}: {
  accentColor: string;
  onAccentColorChange: (accentColor: string) => void;
  onStyleChange: (style: EarnButtonStyle) => void;
  style: EarnButtonStyle;
}) {
  const t = useTranslations();
  const isPresetColor = EARN_BUTTON_ACCENT_COLOR_OPTIONS.some(
    (option) => option.color === accentColor
  );
  return (
    <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
      <fieldset className="min-w-0">
        <legend className="mb-2 text-xs font-medium text-secondary">
          {t("DashboardMarkets.earnProgram.styleTitle")}
        </legend>
        <div className="grid w-full min-w-64 grid-cols-3 gap-1 rounded-full bg-fill-subtle p-1 sm:w-auto">
          {EARN_BUTTON_STYLE_OPTIONS.map((option) => {
            const selected = style === option.value;
            return (
              <label
                className={cn(
                  "flex h-9 cursor-pointer items-center justify-center rounded-full px-5 text-xs font-medium transition-colors",
                  selected
                    ? "bg-surface-raised text-primary shadow-sm"
                    : "text-secondary hover:text-primary"
                )}
                key={option.value}
              >
                <input
                  checked={selected}
                  className="sr-only"
                  name="earn-button-style"
                  onChange={() => onStyleChange(option.value)}
                  type="radio"
                  value={option.value}
                />
                {t(option.labelKey)}
              </label>
            );
          })}
        </div>
      </fieldset>

      {style === "accent" ? (
        <fieldset className="min-w-0">
          <legend className="mb-2 text-xs font-medium text-secondary">
            {t("DashboardMarkets.earnProgram.accentColor")}
          </legend>
          <div className="flex h-11 items-center gap-2 rounded-full border border-border-default bg-surface-raised px-2 shadow-sm">
            {EARN_BUTTON_ACCENT_COLOR_OPTIONS.map((option) => {
              const selected = accentColor === option.color;
              return (
                <button
                  aria-label={t(option.labelKey)}
                  aria-pressed={selected}
                  className={cn(
                    "size-7 rounded-full border border-black/10 transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2",
                    selected && "ring-2 ring-primary ring-offset-2 ring-offset-surface-raised"
                  )}
                  key={option.color}
                  onClick={() => onAccentColorChange(option.color)}
                  style={{ backgroundColor: option.color }}
                  type="button"
                />
              );
            })}
            <label
              className={cn(
                "relative flex size-7 cursor-pointer items-center justify-center rounded-full border border-border-default text-primary focus-within:outline-2 focus-within:outline-offset-2",
                !isPresetColor && "ring-2 ring-primary ring-offset-2 ring-offset-surface-raised"
              )}
              style={{ backgroundColor: accentColor }}
            >
              <PaletteIcon aria-hidden="true" className="size-3.5 text-white drop-shadow-sm" />
              <span className="sr-only">{t("DashboardMarkets.earnProgram.customAccentColor")}</span>
              <input
                aria-label={t("DashboardMarkets.earnProgram.customAccentColor")}
                className="absolute inset-0 cursor-pointer opacity-0"
                onChange={(event) => onAccentColorChange(event.currentTarget.value.toUpperCase())}
                type="color"
                value={accentColor}
              />
            </label>
            <span className="min-w-[4.5rem] text-center text-xs text-secondary tabular-nums">
              {accentColor}
            </span>
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}
