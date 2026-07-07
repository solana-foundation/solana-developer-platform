"use client";

import { ChevronRight, ExternalLink, Info } from "lucide-react";
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

  const CategoryIcon = category.icon;

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
          Select the specific kind of asset within your chosen category.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-3 rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white px-4 py-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[rgba(28,28,29,0.05)] text-[#1c1c1d]">
            <CategoryIcon className="h-4 w-4" />
          </span>
          <div>
            <p className="text-xs text-[rgba(28,28,29,0.55)]">Selected category</p>
            <p className="text-sm font-medium text-[#1c1c1d]">{category.label}</p>
          </div>
          <button
            type="button"
            onClick={() => goToStep("classification")}
            className="ml-2 rounded-lg px-2 py-1 text-sm font-medium text-[#1c1c1d] transition-colors hover:bg-[rgba(28,28,29,0.05)]"
          >
            Change
          </button>
        </div>
        <ChevronRight className="h-4 w-4 text-[rgba(28,28,29,0.35)]" />
        <div className="rounded-2xl border border-dashed border-[rgba(28,28,29,0.16)] px-4 py-3">
          <p className="text-xs text-[rgba(28,28,29,0.5)]">Next step</p>
          <p className="text-sm font-medium text-[rgba(28,28,29,0.7)]">Choose sub asset type</p>
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <p className="text-sm font-medium text-text-high">Sub asset type</p>
          <p className="mt-0.5 text-sm text-[rgba(28,28,29,0.55)]">
            These are the supported kinds of assets within {category.label}.
          </p>
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
      </div>

      <div className="flex items-center gap-3 rounded-2xl border border-[rgba(28,28,29,0.1)] bg-[rgba(28,28,29,0.02)] px-4 py-3">
        <Info className="h-4 w-4 shrink-0 text-[rgba(28,28,29,0.5)]" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-[#1c1c1d]">Not sure which to choose?</p>
          <p className="text-sm text-[rgba(28,28,29,0.6)]">
            You can learn more about each sub asset type in our documentation.
          </p>
        </div>
        <a
          href="https://platform.solana.com/docs"
          target="_blank"
          rel="noreferrer"
          className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-[#1c1c1d] hover:underline"
        >
          View guide
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
    </motion.div>
  );
}
