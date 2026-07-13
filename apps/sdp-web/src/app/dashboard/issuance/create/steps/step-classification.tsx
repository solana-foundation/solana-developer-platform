"use client";

import { ArrowRight } from "lucide-react";
import { motion } from "motion/react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/i18n/provider";
import { getDefaultAccessControl, getRecommendedCapacities } from "../asset-details-config";
import { ASSET_TAXONOMY, getCategoryPresentation } from "../asset-taxonomy";
import { getDefaultPublicFields } from "../draft-mapping";
import { SelectionCard } from "../selection-card";
import { useIssuanceDraft } from "../use-issuance-draft";

export function StepClassification() {
  const t = useTranslations();
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
        <h2 className="text-xl font-medium text-primary">
          {t("DashboardIssuance.classification.title")}
        </h2>
        <p className="mt-1 text-sm text-secondary">
          {t("DashboardIssuance.classification.description")}
        </p>
      </div>

      <div className="grid max-w-md gap-2">
        <Label htmlFor="asset-name">{t("DashboardIssuance.classification.name")}</Label>
        <Input
          id="asset-name"
          value={draft.name}
          onChange={(event) => updateDraft({ name: event.currentTarget.value })}
          placeholder={t("DashboardIssuance.classification.namePlaceholder")}
        />
        <p className="text-sm text-tertiary">{t("DashboardIssuance.classification.nameHint")}</p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <Label>{t("DashboardIssuance.classification.chooseClassification")}</Label>
          <a
            href="https://platform.solana.com/docs"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
          >
            {t("DashboardIssuance.classification.notSure")}
            <ArrowRight className="h-3.5 w-3.5" />
          </a>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {ASSET_TAXONOMY.map((entry) => (
            <SelectionCard
              key={entry.category}
              icon={entry.icon}
              title={t(entry.labelKey)}
              description={t(entry.descriptionKey)}
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
          <Label>{t("DashboardIssuance.classification.chooseAssetType")}</Label>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {category.subTypes.map((subType) => (
              <SelectionCard
                key={subType.type}
                icon={subType.icon}
                title={t(subType.labelKey)}
                description={t(subType.descriptionKey)}
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
