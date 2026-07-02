"use client";

import { ChevronDown, Info } from "lucide-react";
import { motion } from "motion/react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ASSET_TAXONOMY } from "../asset-taxonomy";
import { SelectionCard } from "../selection-card";
import { useIssuanceDraft } from "../use-issuance-draft";

export function StepClassification() {
  const { draft, updateDraft } = useIssuanceDraft();

  return (
    <motion.div
      key="classification"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="space-y-8"
    >
      <div>
        <h2 className="text-2xl font-medium text-[#1c1c1d]">What is this asset?</h2>
        <p className="mt-1.5 text-sm text-[rgba(28,28,29,0.62)]">
          Start by telling us what this asset represents and how it should be classified.
        </p>
      </div>

      <div className="space-y-3">
        <Label>Choose a classification</Label>
        <div className="grid gap-4 sm:grid-cols-3">
          {ASSET_TAXONOMY.map((category) => (
            <SelectionCard
              key={category.category}
              icon={category.icon}
              title={category.label}
              description={category.description}
              selected={draft.assetCategory === category.category}
              onSelect={() => {
                if (draft.assetCategory === category.category) {
                  return;
                }
                // Changing category invalidates any previously chosen sub type.
                updateDraft({ assetCategory: category.category, assetType: null });
              }}
            />
          ))}
        </div>
      </div>

      <div className="grid max-w-md gap-2">
        <Label htmlFor="asset-name">Name</Label>
        <Input
          id="asset-name"
          value={draft.name}
          onChange={(event) => updateDraft({ name: event.currentTarget.value })}
          placeholder="e.g., USD Workshop Money Market Fund"
        />
        <p className="text-sm text-[rgba(28,28,29,0.55)]">A clear name to identify this asset.</p>
      </div>

      <details className="group rounded-2xl border border-[rgba(28,28,29,0.1)] bg-[rgba(28,28,29,0.02)] p-4">
        <summary className="flex cursor-pointer list-none items-center gap-3 [&::-webkit-details-marker]:hidden">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[rgba(28,28,29,0.05)] text-[#1c1c1d]">
            <Info className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-[#1c1c1d]">
              About asset classification
            </span>
            <span className="block text-sm text-[rgba(28,28,29,0.6)]">
              This helps us apply the right settings, compliance requirements, and public
              disclosures for your asset.
            </span>
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-[rgba(28,28,29,0.5)] transition-transform group-open:rotate-180" />
        </summary>
        <p className="mt-3 border-t border-[rgba(28,28,29,0.08)] pt-3 text-sm leading-relaxed text-[rgba(28,28,29,0.62)]">
          The classification determines the asset category and the supported asset types available
          in the next step. It also drives which fields are published to the public token metadata
          and which stay private. You can change it before creating the draft.
        </p>
      </details>
    </motion.div>
  );
}
