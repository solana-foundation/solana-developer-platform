"use client";

import type { Token } from "@sdp/types";
import {
  Boxes,
  Braces,
  DollarSign,
  FileText,
  Lock,
  type LucideIcon,
  ScrollText,
  SlidersHorizontal,
  Tag,
} from "lucide-react";
import { useState } from "react";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { getCategorySections } from "../../../create/asset-details-config";
import { DocumentRows } from "../../../create/document-rows";
import { buildIssuanceMetadata, getRequiredAssetDetailKeys } from "../../../create/draft-mapping";
import {
  CustomFieldRows,
  DetailField,
  FormCard,
  ReadOnlyField,
  TextField,
} from "../../../create/form-primitives";
import type { DraftState } from "../../../create/issuance-draft-wizard.types";
import { MetadataJsonPanel, MetadataJsonToggle } from "../../../create/metadata-json";
import {
  findWalletByWalletId,
  getSignerWalletOptionLabel,
} from "../../token-management-workspace.utils";
import type { AssetProfileForm } from "../use-asset-profile-form";
import type { TokenOperations } from "../use-token-operations";

// Category detail sections keep their config-defined titles; the icon is a
// presentation concern of this tab.
const SECTION_ICONS: Record<string, LucideIcon> = {
  "DashboardIssuance.config.financialDetails": DollarSign,
  "DashboardIssuance.config.securityDetails": ScrollText,
  "DashboardIssuance.config.categoryAssetDetails": Boxes,
};

export function DetailsTab({
  token,
  form,
  ops,
}: {
  token: Token;
  form: AssetProfileForm;
  ops: TokenOperations;
}) {
  const t = useTranslations();
  const { draft, updateDraft, saving, errors, showErrors } = form;
  const [jsonOpen, setJsonOpen] = useState(false);
  const sections = getCategorySections(draft.assetCategory);
  const requiredKeys = getRequiredAssetDetailKeys(draft);

  // Same reveal semantics as the creation wizard: live feedback once a field
  // has content, everything after a failed save attempt.
  const fieldError = (key: keyof DraftState): string | undefined => {
    const message = errors[key];
    if (!message) {
      return undefined;
    }
    const hasContent = String(draft[key] ?? "").trim().length > 0;
    return hasContent || showErrors ? message : undefined;
  };
  const nameError = fieldError("name");
  const descriptionError = fieldError("description");

  const signerWallet = findWalletByWalletId(ops.authorityWallets, draft.signingWalletId);
  const signerLabel = signerWallet
    ? getSignerWalletOptionLabel(signerWallet, t)
    : draft.signingWalletId || t("DashboardIssuance.assetDetails.projectDefaultSigner");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="inline-flex items-center gap-1.5 text-sm text-[rgba(28,28,29,0.55)]">
          <Lock className="h-3.5 w-3.5 shrink-0" />
          {t("DashboardIssuance.assetProfileDetails.privateByDefault")}
        </p>
        <MetadataJsonToggle open={jsonOpen} onToggle={() => setJsonOpen((prev) => !prev)} />
      </div>

      {jsonOpen ? <MetadataJsonPanel metadata={buildIssuanceMetadata(draft)} /> : null}

      <FormCard
        title={t("DashboardIssuance.assetDetails.about")}
        description={t("DashboardIssuance.assetDetails.aboutDescription")}
        icon={Tag}
      >
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <TextField
            label={t("DashboardIssuance.forms.name")}
            required
            disabled={saving}
            value={draft.name}
            onChange={(value) => updateDraft({ name: value })}
            placeholder={t("DashboardIssuance.assetDetails.namePlaceholder")}
            error={nameError}
          />
          <div className="grid grid-cols-2 items-start gap-4">
            <ReadOnlyField
              label={t("DashboardIssuance.create.symbol")}
              value={token.symbol}
              lockReason={t("DashboardIssuance.assetDetails.lockedAfterCreation")}
            />
            <ReadOnlyField
              label={t("DashboardIssuance.create.decimals")}
              value={String(token.decimals)}
              lockReason={t("DashboardIssuance.assetDetails.lockedAfterCreation")}
            />
          </div>
        </div>
        <div className="mt-4 grid gap-1.5">
          <Label htmlFor="asset-description">
            {t("DashboardIssuance.assetDetails.descriptionLabel")}{" "}
            <span aria-hidden className="text-[#c71f37]">
              *
            </span>
            <span className="sr-only"> {t("DashboardIssuance.create.required")}</span>
          </Label>
          <textarea
            id="asset-description"
            disabled={saving}
            value={draft.description}
            onChange={(event) => updateDraft({ description: event.currentTarget.value })}
            rows={3}
            placeholder={t("DashboardIssuance.assetDetails.descriptionPlaceholder")}
            aria-invalid={descriptionError ? true : undefined}
            className={cn(
              "w-full rounded-[14px] border bg-white px-4 py-3 text-sm text-[#1c1c1d] outline-none transition-[box-shadow,border-color] placeholder:text-[rgba(28,28,29,0.4)]",
              descriptionError
                ? "border-[#c71f37] focus:border-[#c71f37] focus:ring-2 focus:ring-[rgba(199,31,55,0.15)]"
                : "border-[rgba(28,28,29,0.14)] focus:border-[rgba(28,28,29,0.28)] focus:ring-2 focus:ring-[rgba(28,28,29,0.12)]"
            )}
          />
          {descriptionError ? (
            <p className="text-xs text-[#c71f37]" role="alert">
              {descriptionError}
            </p>
          ) : null}
        </div>
        <div className="mt-4 grid items-start gap-4 sm:grid-cols-2">
          <TextField
            label={t("DashboardIssuance.assetDetails.website")}
            disabled={saving}
            value={draft.website}
            onChange={(value) => updateDraft({ website: value })}
            placeholder={t("DashboardIssuance.assetDetails.websitePlaceholder")}
            error={fieldError("website")}
          />
          <TextField
            label={t("DashboardIssuance.assetDetails.logoImageUrl")}
            disabled={saving}
            value={draft.imageUrl}
            onChange={(value) => updateDraft({ imageUrl: value })}
            placeholder={t("DashboardIssuance.assetDetails.logoPlaceholder")}
            help={t("DashboardIssuance.assetDetails.logoHint")}
            error={fieldError("imageUrl")}
          />
        </div>
      </FormCard>

      {sections.map((section) => (
        <FormCard
          key={section.titleKey}
          title={t(section.titleKey)}
          description={section.descriptionKey ? t(section.descriptionKey) : undefined}
          icon={SECTION_ICONS[section.titleKey]}
        >
          <div className="grid items-start gap-4 sm:grid-cols-2">
            {section.fields.map((field) => (
              <DetailField
                key={field.key}
                field={field}
                draft={draft}
                updateDraft={updateDraft}
                required={requiredKeys.has(field.key)}
                disabled={saving}
                error={fieldError(field.key)}
              />
            ))}
          </div>
        </FormCard>
      ))}

      <FormCard
        title={t("DashboardIssuance.assetDetails.documents")}
        description={t("DashboardIssuance.assetDetails.documentsDescription")}
        icon={FileText}
      >
        <DocumentRows
          documents={draft.documents}
          onChange={(documents) => updateDraft({ documents })}
          disabled={saving}
        />
      </FormCard>

      <FormCard
        title={t("DashboardIssuance.assetDetails.customFields")}
        description={t("DashboardIssuance.assetDetails.customFieldsDescription")}
        icon={Braces}
      >
        <CustomFieldRows
          fields={draft.customFields}
          onChange={(customFields) => updateDraft({ customFields })}
          disabled={saving}
        />
      </FormCard>

      <FormCard
        title={t("DashboardIssuance.assetDetails.operational")}
        description={t("DashboardIssuance.assetDetails.operationalDescription")}
        icon={SlidersHorizontal}
      >
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <ReadOnlyField
            label={t("DashboardIssuance.assetDetails.signingWallet")}
            value={signerLabel}
            lockReason={t("DashboardIssuance.assetDetails.signingWalletLockReason")}
          />
        </div>
      </FormCard>
    </div>
  );
}
