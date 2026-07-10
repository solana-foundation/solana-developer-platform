"use client";

import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface SelectionCardProps {
  icon: LucideIcon;
  title: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}

export function SelectionCard({
  icon: Icon,
  title,
  description,
  selected,
  onSelect,
}: SelectionCardProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      // Opt this card back into Enter-to-advance: re-selecting the current card
      // is a no-op, so the wizard's global Enter handler treats a focused card as
      // "advance" instead of skipping it like other buttons.
      data-enter-advance
      className={cn(
        "flex flex-col rounded-2xl border p-3.5 text-left transition-colors",
        selected
          ? "border-[#1c1c1d] bg-[rgba(28,28,29,0.05)]"
          : "border-[rgba(28,28,29,0.14)] bg-white hover:bg-[rgba(28,28,29,0.03)]"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[rgba(28,28,29,0.05)] text-[#1c1c1d]">
          <Icon className="h-4 w-4" />
        </span>
        <span
          className={cn(
            "mt-0.5 flex h-4 w-4 items-center justify-center rounded-full border-2",
            selected ? "border-[#1c1c1d]" : "border-[rgba(28,28,29,0.25)]"
          )}
          aria-hidden
        >
          {selected ? <span className="h-2 w-2 rounded-full bg-[#1c1c1d]" /> : null}
        </span>
      </div>
      <p className="mt-3 text-sm font-semibold text-[#1c1c1d]">{title}</p>
      <p className="mt-1 text-[13px] leading-snug text-[rgba(28,28,29,0.62)]">{description}</p>
    </button>
  );
}
