"use client";

import { ArrowRight } from "lucide-react";
import { motion } from "motion/react";
import { getDefaultAccessControl, getRecommendedCapacities } from "../asset-details-config";
import { getCategoryPresentation } from "../asset-taxonomy";
import { getDefaultPublicFields } from "../draft-mapping";
import { SelectionCard } from "../selection-card";
import { useIssuanceDraft } from "../use-issuance-draft";

export function StepSubAssetType() {
  const { draft, updateDraft, goToStep } = useIssuanceDraft();
  const category = getCategoryPresentation(draft.assetCategory);

  if (!category) {
    return (
      <motion.div
        key="asset-details-empty"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        className="rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white p-6"
      >
        <p className="text-sm text-[rgba(28,28,29,0.62)]">
          Choose a classification first to see its supported asset types.
        </p>
        <button
          type="button"
          onClick={() => goToStep("classification")}
          className="mt-3 text-sm font-medium text-[#1c1c1d] underline underline-offset-4"
        >
          Back to classification
        </button>
      </motion.div>
    );
  }

  return (
    <motion.div
      key="asset-details"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="space-y-8"
    >
      <div>
        <h2 className="text-2xl font-medium text-[#1c1c1d]">Choose sub asset type</h2>
        <p className="mt-1.5 text-sm text-[rgba(28,28,29,0.62)]">
          Select the specific kind of asset within{" "}
          <span className="font-medium text-[#1c1c1d]">{category.label}</span>.
        </p>
        <a
          href="https://platform.solana.com/docs"
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-[#1c1c1d] hover:underline"
        >
          Not sure what to pick
          <ArrowRight className="h-3.5 w-3.5" />
        </a>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
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
  );
}
