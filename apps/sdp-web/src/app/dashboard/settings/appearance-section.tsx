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
import { useHeaderAppearance } from "../issuance/[tokenId]/asset-profile/header-appearance";

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
// Full width while the viewport is too narrow to fit the fixed columns, then a
// fixed 6.5rem-per-option track — enough for the longest option label in either
// locale ("Système", "Par défaut"), and narrow enough that all three groups fit
// one row in the settings card.
const SEGMENT_GROUP_CLASSES =
  "grid w-full gap-1 rounded-xl border border-border-default bg-fill-subtle p-1 sm:w-fit";

const SEGMENT_COLUMN_CLASSES: Record<number, string> = {
  2: "grid-cols-2 sm:grid-cols-[repeat(2,6.5rem)]",
  3: "grid-cols-3 sm:grid-cols-[repeat(3,6.5rem)]",
};

// The hint wraps to the width of the control above it — 6.5rem per option plus
// the group's gap and padding. Without a cap the sentence sets the fieldset's
// width (a one-line hint runs to ~355px against a 224px control), which is what
// pushes the groups onto separate rows even when the controls would fit.
const SEGMENT_HINT_WIDTH_CLASSES: Record<number, string> = {
  2: "sm:max-w-[14rem]",
  3: "sm:max-w-[20.5rem]",
};

const SEGMENT_ITEM_CLASSES =
  "flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-lg px-1.5 text-xs font-medium transition-colors motion-reduce:transition-none sm:gap-1.5 sm:px-2.5 sm:text-sm";

export function AppearanceSection({
  showAssetHeaderControls = false,
}: {
  showAssetHeaderControls?: boolean;
}) {
  const t = useTranslations();
  const { hydrated: themeHydrated, preference, setPreference } = useTheme();
  const { appearance, hydrated: appearanceHydrated, setAppearanceOption } = useHeaderAppearance();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("DashboardCustody.appearance")}</CardTitle>
        <CardDescription>{t("DashboardCustody.appearanceDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        {/* Three arrangements, chosen by how much room this card actually has:
            all three groups on one row, then the theme on its own row with the
            pair below it, then everything stacked. Measured against the card
            rather than the viewport, because the sidebar collapses — the same
            window gives the card two very different widths, and a viewport
            breakpoint gets that wrong exactly when it matters.

            The thresholds are the groups' own widths: 6.5rem per option plus
            0.5rem of gap and padding, so the theme is 20.5rem (328px) and each
            two-option group 14rem (224px) — hints capped to match, or the sentence
            would decide instead. The pair needs 224+224+24 ≈ 472px; all three
            need 328+224+224+48 ≈ 824px.

            Flex, not a grid: the tracks never shrink, so equal grid columns would
            be narrower than the theme group and it would spill over its
            neighbour. Wrapping gives up a row instead. */}
        <div className="@container">
          <div className="flex flex-col gap-x-6 gap-y-6 @min-[480px]:flex-row @min-[480px]:flex-wrap">
            <SegmentedFieldset
              // The theme takes the whole first row until all three fit across.
              className="@min-[480px]:basis-full @min-[840px]:basis-auto"
              legend={t("Shared.dashboardShell.colorTheme")}
              hint={
                themeHydrated ? t(PREFERENCE_HINT_KEYS[preference]) : t(PREFERENCE_HINT_KEYS.system)
              }
              hydrated={themeHydrated}
              value={preference}
              onChange={setPreference}
              options={THEME_PREFERENCES.map((option) => ({
                value: option,
                label: t(PREFERENCE_LABEL_KEYS[option]),
                icon: PREFERENCE_ICONS[option],
              }))}
            />

            {/* Developer-only: the issuance asset header's two axes. Every user gets
              HEADER_APPEARANCE_DEFAULTS unless one of us changes it here. */}
            {showAssetHeaderControls ? (
              <>
                <SegmentedFieldset
                  badge={t("DashboardCustody.devMode")}
                  legend={t("DashboardCustody.assetHeaderLayout")}
                  hint={t("DashboardCustody.assetHeaderLayoutHint")}
                  hydrated={appearanceHydrated}
                  value={appearance.layout}
                  onChange={(next) => setAppearanceOption("layout", next)}
                  options={[
                    { value: "default", label: t("DashboardCustody.assetHeaderLayoutDefault") },
                    { value: "mirrored", label: t("DashboardCustody.assetHeaderLayoutMirrored") },
                  ]}
                />

                <SegmentedFieldset
                  badge={t("DashboardCustody.devMode")}
                  legend={t("DashboardCustody.assetHeaderMode")}
                  hint={t("DashboardCustody.assetHeaderModeHint")}
                  hydrated={appearanceHydrated}
                  value={appearance.mode}
                  onChange={(next) => setAppearanceOption("mode", next)}
                  options={[
                    { value: "default", label: t("DashboardCustody.assetHeaderModeDefault") },
                    { value: "expanded", label: t("DashboardCustody.assetHeaderModeExpanded") },
                  ]}
                />
              </>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * A labelled radio group rendered as a segmented control, with a hint under it.
 *
 * Until `hydrated` the group renders placeholders rather than a selection: the
 * server render is also the first client render, and painting a checked option
 * there would flash the wrong one for anyone whose stored choice isn't the default.
 */
function SegmentedFieldset<T extends string>({
  legend,
  badge,
  hint,
  hydrated,
  value,
  onChange,
  options,
  className,
}: {
  legend: string;
  badge?: string;
  hint: string;
  hydrated: boolean;
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; label: string; icon?: LucideIcon }[];
  className?: string;
}) {
  const groupName = useId();
  const hintId = useId();
  const groupClasses = cn(SEGMENT_GROUP_CLASSES, SEGMENT_COLUMN_CLASSES[options.length]);

  return (
    // fieldset + legend already exposes a named group whose radios are announced
    // together, so no explicit radiogroup role is needed on top of it.
    <fieldset
      aria-busy={!hydrated}
      aria-describedby={hintId}
      className={cn("space-y-1.5 border-0 p-0", className)}
    >
      {/* The badge sits inside the legend so it is part of the group's accessible
          name — a control this changes shouldn't look like a customer setting. */}
      <legend className="flex flex-wrap items-center gap-2 text-sm font-medium text-primary">
        {legend}
        {badge ? (
          <span className="rounded-full bg-fill px-1.5 py-0.5 text-[10px] font-medium tracking-[0.06em] text-tertiary uppercase">
            {badge}
          </span>
        ) : null}
      </legend>

      {hydrated ? (
        <div className={groupClasses}>
          {options.map((option) => {
            const Icon = option.icon;
            const isSelected = value === option.value;
            return (
              <label
                key={option.value}
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
                  value={option.value}
                  checked={isSelected}
                  onChange={() => onChange(option.value)}
                  className="sr-only"
                />
                {/* Decorative only. Under ~360px the icon squeezes "System" into an
                    ellipsis, so the label wins the space on the narrowest phones. */}
                {Icon ? (
                  <Icon
                    aria-hidden="true"
                    className="hidden h-4 w-4 shrink-0 min-[360px]:block"
                    strokeWidth={1.9}
                  />
                ) : null}
                <span className="truncate">{option.label}</span>
              </label>
            );
          })}
        </div>
      ) : (
        // Same wrapper, so swapping in the real control cannot shift the layout.
        <div className={groupClasses}>
          {options.map((option) => (
            <SkeletonBlock key={option.value} className="h-9 w-full rounded-lg" />
          ))}
        </div>
      )}

      <p
        className={cn("text-xs text-tertiary", SEGMENT_HINT_WIDTH_CLASSES[options.length])}
        id={hintId}
      >
        {hint}
      </p>
    </fieldset>
  );
}
