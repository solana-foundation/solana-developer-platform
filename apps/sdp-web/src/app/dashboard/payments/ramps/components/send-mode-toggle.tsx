"use client";

import { cn } from "@/lib/utils";

export type SendMode = "single" | "batch";

const MODES = [
  { id: "single", label: "Single" },
  { id: "batch", label: "Batch" },
] as const satisfies readonly { id: SendMode; label: string }[];

export function SendModeToggle({
  value,
  onChange,
}: {
  value: SendMode;
  onChange: (value: SendMode) => void;
}) {
  return (
    <div className="inline-flex items-center border-b border-border-light">
      {MODES.map((mode) => (
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
              Onchain
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
