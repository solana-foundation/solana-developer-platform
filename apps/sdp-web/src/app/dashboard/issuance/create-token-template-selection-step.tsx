"use client";

import { ChevronRight } from "lucide-react";
import { motion } from "motion/react";
import type { TemplateSelection } from "./create-token-modal.types";
import { templateCards } from "./create-token-modal.utils";

interface TemplateSelectionStepProps {
  onSelect: (template: TemplateSelection) => void;
}

export function TemplateSelectionStep({ onSelect }: TemplateSelectionStepProps) {
  return (
    <motion.div
      key="template-selection"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="px-6 py-6"
    >
      <div className="space-y-3">
        {templateCards.map((card) => (
          <TemplateCard key={card.id} descriptor={card} onSelect={onSelect} />
        ))}
      </div>
    </motion.div>
  );
}

function TemplateCard({
  descriptor,
  onSelect,
}: {
  descriptor: (typeof templateCards)[number];
  onSelect: (template: TemplateSelection) => void;
}) {
  const Icon = descriptor.icon;

  if (!descriptor.enabled || !descriptor.template) {
    return (
      <div
        aria-disabled
        className="cursor-not-allowed flex items-center justify-between rounded-2xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.02)] px-5 py-4 opacity-70"
      >
        <div className="flex min-w-0 items-center gap-4">
          <div
            className={[
              "flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl",
              descriptor.iconClassName,
            ].join(" ")}
          >
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xl leading-none font-semibold text-[#1c1c1d]">{descriptor.name}</p>
            <p className="mt-2 text-base text-[rgba(28,28,29,0.58)]">{descriptor.description}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(descriptor.template as TemplateSelection)}
      className="cursor-pointer flex w-full items-center justify-between rounded-2xl border border-[rgba(28,28,29,0.12)] bg-white px-5 py-4 text-left transition-colors hover:bg-[rgba(28,28,29,0.03)]"
    >
      <div className="flex min-w-0 items-center gap-4">
        <div
          className={[
            "flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl",
            descriptor.iconClassName,
          ].join(" ")}
        >
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="text-xl leading-none font-semibold text-[#1c1c1d]">{descriptor.name}</p>
          <p className="mt-2 text-base text-[rgba(28,28,29,0.66)]">{descriptor.description}</p>
        </div>
      </div>
      <ChevronRight className="ml-3 h-5 w-5 shrink-0 text-[rgba(28,28,29,0.56)]" />
    </button>
  );
}
