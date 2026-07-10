"use client";

import { ArrowRight } from "lucide-react";
import { motion } from "motion/react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getDefaultAccessControl, getRecommendedCapacities } from "../asset-details-config";
import { ASSET_TAXONOMY, getCategoryPresentation } from "../asset-taxonomy";
import { getDefaultPublicFields } from "../draft-mapping";
import { SelectionCard } from "../selection-card";
import { useIssuanceDraft } from "../use-issuance-draft";

export function StepClassification() {
  const { draft, updateDraft } = useIssuanceDraft();
  // Sub-asset options only appear once a classification is chosen — the grid is
  // scoped to the selected category's supported sub types.
  const category = getCategoryPresentation(draft.assetCategory);

  return (
    <motion.div
      key="classification"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="space-y-6"
    >
      <div>
        <h2 className="text-xl font-medium text-primary">What is this asset?</h2>
        <p className="mt-1 text-sm text-secondary">
          Start by telling us what this asset represents and how it should be classified.
        </p>
      </div>

      <div className="grid max-w-md gap-2">
        <Label htmlFor="asset-name">Name</Label>
        <Input
          id="asset-name"
          value={draft.name}
          onChange={(event) => updateDraft({ name: event.currentTarget.value })}
          placeholder="e.g., USD Workshop Money Market Fund"
        />
        <p className="text-sm text-tertiary">A clear name to identify this asset.</p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <Label>Choose a classification</Label>
          <a
            href="https://platform.solana.com/docs"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
          >
            Not sure what to pick
            <ArrowRight className="h-3.5 w-3.5" />
          </a>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {ASSET_TAXONOMY.map((entry) => (
            <SelectionCard
              key={entry.category}
              icon={entry.icon}
              title={entry.label}
              description={entry.description}
              selected={draft.assetCategory === entry.category}
              onSelect={() => {
                if (draft.assetCategory === entry.category) {
                  return;
                }
                // Changing category invalidates any previously chosen sub type.
                updateDraft({ assetCategory: entry.category, assetType: null });
              }}
            />
          ))}
        </div>
      </div>

      {category ? (
        // Keyed by category so switching classifications re-runs the reveal with
        // the new category's sub types.
        <motion.div
          key={category.category}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-3"
        >
          <Label>Choose asset type</Label>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {category.subTypes.map((subType) => (
              <SelectionCard
                key={subType.type}
                icon={subType.icon}
                title={subType.label}
                description={subType.description}
                selected={draft.assetType === subType.type}
                onSelect={() => {
                  if (draft.assetType === subType.type) {
                    return;
                  }
                  // Picking a (new) type pre-selects its recommended capacities,
                  // default access control, and default public fields (the
                  // "Recommended" defaults the user can still change).
                  updateDraft({
                    assetType: subType.type,
                    capacities: getRecommendedCapacities(category.category, subType.type),
                    accessControl: getDefaultAccessControl(category.category),
                    publicFields: getDefaultPublicFields(category.category, subType.type),
                  });
                }}
              />
            ))}
          </div>
        </motion.div>
      ) : null}
    </motion.div>
  );
}
