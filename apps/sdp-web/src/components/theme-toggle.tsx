"use client";

import { MoonIcon, SunIcon } from "lucide-react";
import { useId } from "react";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useTheme } from "@/contexts/theme-context";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";

export function ThemeToggle({
  collapsed = false,
  variant = "sidebar",
}: {
  collapsed?: boolean;
  variant?: "sidebar" | "header";
}) {
  const { theme, toggleTheme } = useTheme();
  const t = useTranslations();
  const switchId = useId();
  const isDark = theme === "dark";
  const accessibleName = t("Shared.dashboardShell.colorTheme");

  if (variant === "header" || collapsed) {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={isDark}
        aria-label={accessibleName}
        title={accessibleName}
        onClick={toggleTheme}
        className={cn(
          "flex shrink-0 cursor-pointer items-center justify-center rounded-lg text-secondary outline-none transition-colors hover:bg-fill-strong hover:text-primary focus-visible:ring-2 focus-visible:ring-border-strong focus-visible:ring-offset-2 focus-visible:ring-offset-surface-raised motion-reduce:transition-none",
          variant === "header" ? "h-8 w-8" : "h-10 w-full"
        )}
      >
        <MoonIcon aria-hidden="true" className="h-5 w-5 dark:hidden" strokeWidth={1.9} />
        <SunIcon aria-hidden="true" className="hidden h-5 w-5 dark:block" strokeWidth={1.9} />
      </button>
    );
  }

  return (
    <div className="flex h-10 w-full items-center justify-between gap-3 rounded-[var(--button-radius-lg)] px-3 text-base text-secondary transition-colors hover:bg-fill-strong hover:text-primary motion-reduce:transition-none">
      <label htmlFor={switchId} className="flex min-w-0 cursor-pointer items-center gap-3">
        <MoonIcon aria-hidden="true" className="h-5 w-5 shrink-0" strokeWidth={1.9} />
        <span className="whitespace-nowrap">{t("Shared.dashboardShell.darkMode")}</span>
      </label>
      <ToggleSwitch
        id={switchId}
        checked={isDark}
        onChange={toggleTheme}
        aria-label={accessibleName}
      />
    </div>
  );
}
