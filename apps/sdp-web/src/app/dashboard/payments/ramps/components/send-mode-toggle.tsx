"use client";

import { cn } from "@/lib/utils";
import { useTranslations } from "@/i18n/provider";

export type SendMode = "single" | "batch";

export function SendModeToggle({
  value,
  onChange,
}: {
  value: SendMode;
  onChange: (value: SendMode) => void;
}) {
  const t = useTranslations();
  const modes = [
    { id: "single" as const, label: t("DashboardPayments.sendMode.single") },
    { id: "batch" as const, label: t("DashboardPayments.sendMode.batch") },
  ];
  return (
    <div className="inline-flex items-center border-b border-border-light">
      {modes.map((mode) => (
        <button
          key={mode.id}
          type="button"
          onClick={() => onChange(mode.id)}
          className={cn(
            "-mb-px inline-flex items-center justify-center gap-1.5 border-b-2 px-4 py-2 text-sm font-medium transition-colors",
            value === mode.id
              ? "border-text-extra-high text-text-extra-high"
              : "border-transparent text-text-low hover:text-text-extra-high"
          )}
        >
          {mode.label}
          {mode.id === "batch" ? (
            <span className="rounded-full bg-border-extra-light px-1.5 text-xs font-semibold uppercase tracking-wide text-text-low">
              {t("DashboardPayments.sendMode.onchain")}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
