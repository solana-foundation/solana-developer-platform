"use client";

import { ChevronRight } from "lucide-react";
import { motion } from "motion/react";
import { useTranslations } from "@/i18n/provider";
import type { TemplateSelection } from "./create-token-modal.types";
import { getTemplateCards } from "./create-token-modal.utils";

interface TemplateSelectionStepProps {
  onSelect: (template: TemplateSelection) => void;
}

export function TemplateSelectionStep({ onSelect }: TemplateSelectionStepProps) {
  const t = useTranslations();
  const templateCards = getTemplateCards(t);
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
  descriptor: ReturnType<typeof getTemplateCards>[number];
  onSelect: (template: TemplateSelection) => void;
}) {
  const Icon = descriptor.icon;

  if (!descriptor.enabled || !descriptor.template) {
    return (
      <div
        aria-disabled
        className="cursor-not-allowed flex items-center justify-between rounded-2xl border border-border-default bg-fill-subtle px-5 py-4 opacity-70"
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
            <p className="text-xl leading-none font-semibold text-primary">{descriptor.name}</p>
            <p className="mt-2 text-base text-tertiary">{descriptor.description}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(descriptor.template as TemplateSelection)}
      className="cursor-pointer flex w-full items-center justify-between rounded-2xl border border-border-default bg-surface-raised px-5 py-4 text-left transition-colors hover:bg-fill-subtle"
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
          <p className="text-xl leading-none font-semibold text-primary">{descriptor.name}</p>
          <p className="mt-2 text-base text-secondary">{descriptor.description}</p>
        </div>
      </div>
      <ChevronRight className="ml-3 h-5 w-5 shrink-0 text-tertiary" />
    </button>
  );
}
