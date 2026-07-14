"use client";

import { MoonIcon, SunIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useTheme } from "@/contexts/theme-context";
import { cn } from "@/lib/utils";

export function ThemeToggle({
  collapsed = false,
  variant = "sidebar",
}: {
  collapsed?: boolean;
  variant?: "sidebar" | "header";
}) {
  const { theme, toggleTheme } = useTheme();

  // Gate on mount so SSR (always light) and the client's first render agree,
  // avoiding a hydration mismatch on the switch's checked state.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const isDark = mounted && theme === "dark";
  const label = isDark ? "Light mode" : "Dark mode";

  // Header variant: a compact, label-less switch. The sliding knob carries the
  // current mode's icon; the opposite (target) icon sits faint on the far side.
  if (variant === "header") {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={isDark}
        onClick={toggleTheme}
        title={label}
        aria-label={label}
        className="relative h-6 w-11 shrink-0 cursor-pointer rounded-full bg-border-strong outline-none transition-colors focus-visible:ring-2 focus-visible:ring-border-medium"
      >
        <SunIcon
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-1 h-3 w-3 -translate-y-1/2 text-tertiary"
          strokeWidth={2}
        />
        <MoonIcon
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 right-1 h-3 w-3 -translate-y-1/2 text-tertiary"
          strokeWidth={2}
        />
        <span
          aria-hidden="true"
          className={cn(
            "absolute top-0.5 left-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-white shadow transition-transform",
            isDark ? "translate-x-5" : "translate-x-0",
          )}
        >
          {isDark ? (
            <MoonIcon className="h-3 w-3 text-primary" strokeWidth={2} />
          ) : (
            <SunIcon className="h-3 w-3 text-primary" strokeWidth={2} />
          )}
        </span>
      </button>
    );
  }

  // Collapsed rail is too narrow for the switch — use an icon button instead,
  // matching the other collapsed footer items.
  if (collapsed) {
    const Icon = isDark ? SunIcon : MoonIcon;
    return (
      <button
        type="button"
        onClick={toggleTheme}
        title={label}
        aria-label={label}
        className="flex h-10 w-full cursor-pointer items-center justify-center rounded-[var(--button-radius-lg)] text-secondary transition-colors hover:bg-fill-strong hover:text-primary"
      >
        <Icon className="h-5 w-5 shrink-0" strokeWidth={1.9} />
      </button>
    );
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      onClick={toggleTheme}
      className="flex h-10 w-full cursor-pointer items-center justify-between gap-3 rounded-[var(--button-radius-lg)] px-3 text-base text-secondary transition-colors hover:bg-fill-strong hover:text-primary"
    >
      <span className="flex items-center gap-3">
        <MoonIcon className="h-5 w-5 shrink-0" strokeWidth={1.9} />
        <span className="whitespace-nowrap">Dark mode</span>
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "relative h-6 w-11 shrink-0 rounded-full transition-colors",
          isDark ? "bg-primary" : "bg-border-strong",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform",
            isDark ? "translate-x-5" : "translate-x-0",
          )}
        />
      </span>
    </button>
  );
}
