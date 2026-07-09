"use client";

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
    </motion.div>
  );
}
