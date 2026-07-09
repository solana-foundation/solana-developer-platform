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
        "flex flex-col rounded-3xl border p-5 text-left transition-colors",
        selected
          ? "border-[#1c1c1d] bg-[rgba(28,28,29,0.05)]"
          : "border-[rgba(28,28,29,0.14)] bg-white hover:bg-[rgba(28,28,29,0.03)]"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[rgba(28,28,29,0.05)] text-[#1c1c1d]">
          <Icon className="h-5 w-5" />
        </span>
        <span
          className={cn(
            "mt-1 flex h-5 w-5 items-center justify-center rounded-full border-2",
            selected ? "border-[#1c1c1d]" : "border-[rgba(28,28,29,0.25)]"
          )}
          aria-hidden
        >
          {selected ? <span className="h-2.5 w-2.5 rounded-full bg-[#1c1c1d]" /> : null}
        </span>
      </div>
      <p className="mt-4 text-lg font-semibold text-[#1c1c1d]">{title}</p>
      <p className="mt-1.5 text-sm leading-relaxed text-[rgba(28,28,29,0.62)]">{description}</p>
    </button>
  );
}
