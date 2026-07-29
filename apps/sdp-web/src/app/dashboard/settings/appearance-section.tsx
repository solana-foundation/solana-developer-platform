"use client";

import type { LucideIcon } from "lucide-react";
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useId } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { THEME_PREFERENCES, type ThemePreference, useTheme } from "@/contexts/theme-context";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";

const PREFERENCE_ICONS: Record<ThemePreference, LucideIcon> = {
  dark: MoonIcon,
  light: SunIcon,
  system: MonitorIcon,
};

const PREFERENCE_LABEL_KEYS: Record<ThemePreference, MessageKey> = {
  dark: "DashboardCustody.themeDark",
  light: "DashboardCustody.themeLight",
  system: "DashboardCustody.themeSystem",
};

const PREFERENCE_HINT_KEYS: Record<ThemePreference, MessageKey> = {
  dark: "DashboardCustody.themeDarkHint",
  light: "DashboardCustody.themeLightHint",
  system: "DashboardCustody.themeSystemHint",
};

// Shared by the control and its pre-hydration placeholder so both occupy the exact
// same box. Anything that changes the geometry has to change in one place.
// Full width while the viewport is too narrow to fit three fixed columns, then a
// fixed 3x7.5rem track so the control does not stretch across a wide settings card.
const SEGMENT_GROUP_CLASSES =
  "grid w-full grid-cols-3 gap-1 rounded-xl border border-border-default bg-fill-subtle p-1 sm:w-fit sm:grid-cols-[repeat(3,7.5rem)]";

const SEGMENT_ITEM_CLASSES =
  "flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-lg px-1.5 text-xs font-medium transition-colors motion-reduce:transition-none sm:gap-2 sm:px-3 sm:text-sm";

export function AppearanceSection() {
  const t = useTranslations();
  const { hydrated, preference, setPreference } = useTheme();
  const groupName = useId();
  const hintId = useId();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("DashboardCustody.appearance")}</CardTitle>
        <CardDescription>{t("DashboardCustody.appearanceDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        {/* fieldset + legend already exposes a named group whose radios are announced
            together, so no explicit radiogroup role is needed on top of it. */}
        <fieldset
          aria-busy={!hydrated}
          aria-describedby={hintId}
          className="w-full max-w-3xl space-y-2 border-0 p-0"
        >
          <legend className="text-sm font-medium text-primary">
            {t("Shared.dashboardShell.colorTheme")}
          </legend>

          {hydrated ? (
            <div className={SEGMENT_GROUP_CLASSES}>
              {THEME_PREFERENCES.map((option) => {
                const Icon = PREFERENCE_ICONS[option];
                const isSelected = preference === option;
                return (
                  <label
                    key={option}
                    className={cn(
                      SEGMENT_ITEM_CLASSES,
                      "cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-border-strong has-[:focus-visible]:ring-offset-1 has-[:focus-visible]:ring-offset-fill-subtle",
                      isSelected
                        ? "bg-surface-raised text-primary shadow-sm ring-1 ring-border-default"
                        : "text-secondary hover:text-primary"
                    )}
                  >
                    <input
                      type="radio"
                      name={groupName}
                      value={option}
                      checked={isSelected}
                      onChange={() => setPreference(option)}
                      className="sr-only"
                    />
                    {/* Decorative only. Under ~360px the icon squeezes "System" into an
                        ellipsis, so the label wins the space on the narrowest phones. */}
                    <Icon
                      aria-hidden="true"
                      className="hidden h-4 w-4 shrink-0 min-[360px]:block"
                      strokeWidth={1.9}
                    />
                    <span className="truncate">{t(PREFERENCE_LABEL_KEYS[option])}</span>
                  </label>
                );
              })}
            </div>
          ) : (
            // Same wrapper, so swapping in the real control cannot shift the layout.
            <div className={SEGMENT_GROUP_CLASSES}>
              {THEME_PREFERENCES.map((option) => (
                <SkeletonBlock key={option} className="h-9 w-full rounded-lg" />
              ))}
            </div>
          )}

          <p className="text-sm text-tertiary" id={hintId}>
            {hydrated ? t(PREFERENCE_HINT_KEYS[preference]) : t(PREFERENCE_HINT_KEYS.system)}
          </p>
        </fieldset>
      </CardContent>
    </Card>
  );
}
