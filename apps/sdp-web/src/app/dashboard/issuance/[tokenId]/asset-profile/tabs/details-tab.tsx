"use client";

import type { Token } from "@sdp/types";
import {
  Boxes,
  Braces,
  Building2,
  DollarSign,
  FileText,
  Landmark,
  Lock,
  type LucideIcon,
  PieChart,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  Tag,
  TrendingUp,
} from "lucide-react";
import { useState } from "react";
import { Label } from "@/components/ui/label";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { getDetailSections } from "../../../create/asset-details-config";
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
import { buildWalletIdentityForSigner } from "../../../issuance-token-fields";
import { WalletIdentityBadge } from "../../../wallet-identity";
import type { AssetProfileForm } from "../use-asset-profile-form";
import type { TokenOperations } from "../use-token-operations";

// Category detail sections keep their config-defined titles; the icon is a
// presentation concern of this tab.
const SECTION_ICONS: Record<string, LucideIcon> = {
  "DashboardIssuance.config.financialDetails": DollarSign,
  "DashboardIssuance.config.collateralOracleDetails": ShieldCheck,
  "DashboardIssuance.config.securityDetails": ScrollText,
  "DashboardIssuance.config.equityDetails": TrendingUp,
  "DashboardIssuance.config.debtDetails": Landmark,
  "DashboardIssuance.config.fundDetails": PieChart,
  "DashboardIssuance.config.categoryAssetDetails": Boxes,
  "DashboardIssuance.config.realEstateDetails": Building2,
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
  const { draft, updateDraft, saving, errors, showErrors, supplyLocked } = form;
  const [jsonOpen, setJsonOpen] = useState(false);
  const sections = getDetailSections(draft.assetCategory, draft.assetType);
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
  const symbolError = fieldError("symbol");
  const decimalsError = fieldError("decimals");

  // Symbol and decimals are baked into the mint at deploy, so they lock once
  // the token is on-chain and stay editable only while it's a draft.
  const isDeployed = Boolean(token.mintAddress);

  // null while the authority wallets are in flight — see the skeleton below.
  const signerIdentity = buildWalletIdentityForSigner(
    draft.signingWalletId,
    ops.authorityWallets,
    t
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="inline-flex items-center gap-1.5 text-sm text-tertiary">
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
        {/* Name plus the three mint parameters in one flat grid, so every cell is
            filled at every width: stacked on mobile, 2×2 on tablet, and a single
            row at lg where the name takes the double-width cell. A nested pair
            for symbol/decimals would leave max supply orphaned on its own row. */}
        <div className="grid items-start gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <div className="lg:col-span-2">
            <TextField
              label={t("DashboardIssuance.forms.name")}
              required
              disabled={saving}
              value={draft.name}
              onChange={(value) => updateDraft({ name: value })}
              placeholder={t("DashboardIssuance.assetDetails.namePlaceholder")}
              error={nameError}
            />
          </div>
          {isDeployed ? (
            <>
              <ReadOnlyField
                label={t("DashboardIssuance.create.symbol")}
                value={token.symbol}
                lockReason={t("DashboardIssuance.assetDetails.lockedAfterDeploy")}
              />
              <ReadOnlyField
                label={t("DashboardIssuance.create.decimals")}
                value={String(token.decimals)}
                lockReason={t("DashboardIssuance.assetDetails.lockedAfterDeploy")}
              />
            </>
          ) : (
            <>
              <TextField
                label={t("DashboardIssuance.create.symbol")}
                required
                disabled={saving}
                value={draft.symbol}
                onChange={(value) => updateDraft({ symbol: value })}
                placeholder={t("DashboardIssuance.assetDetails.symbolPlaceholder")}
                error={symbolError}
              />
              <TextField
                label={t("DashboardIssuance.create.decimals")}
                required
                type="number"
                disabled={saving}
                value={draft.decimals}
                onChange={(value) => updateDraft({ decimals: value })}
                placeholder={t("DashboardIssuance.create.decimalsPlaceholder")}
                error={decimalsError}
              />
            </>
          )}
          {/* The cap lives on the token row, not in issuance_metadata, and SDP
              enforces it at mint time — so it stays editable for as long as SDP
              can enforce it, i.e. until lock-supply revokes the mint authority.
              The hint states both halves of that (who enforces it, and that it
              can be made permanent); "blank = unlimited" is left to the
              placeholder so the copy stays as short as its neighbours'. */}
          {supplyLocked ? (
            <ReadOnlyField
              label={t("DashboardIssuance.assetDetails.maxSupply")}
              value={token.maxSupply ?? t("DashboardIssuance.assetDetails.maxSupplyUnlimited")}
              lockReason={t("DashboardIssuance.assetDetails.maxSupplyLockedReason")}
            />
          ) : (
            <TextField
              label={t("DashboardIssuance.assetDetails.maxSupply")}
              disabled={saving}
              value={draft.maxSupply}
              onChange={(value) => updateDraft({ maxSupply: value })}
              placeholder={t("DashboardIssuance.assetDetails.maxSupplyPlaceholder")}
              help={t("DashboardIssuance.assetDetails.maxSupplyEnforcementHint")}
              error={fieldError("maxSupply")}
            />
          )}
        </div>
        <div className="mt-4 grid gap-1.5">
          <Label htmlFor="asset-description">
            {t("DashboardIssuance.assetDetails.descriptionLabel")}{" "}
            <span aria-hidden className="text-destructive">
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
              "w-full rounded-[14px] border bg-surface-raised px-4 py-3 text-sm text-primary outline-none transition-[box-shadow,border-color] placeholder:text-muted",
              descriptionError
                ? "border-destructive focus:border-destructive focus:ring-2 focus:ring-destructive-border"
                : "border-border-default focus:border-border-strong focus:ring-2 focus:ring-border-default"
            )}
          />
          {descriptionError ? (
            <p className="text-xs text-destructive" role="alert">
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
        {/* Same card the Operations forms show for a locked signer, so the wallet
            SDP signs with looks the same wherever you meet it — named, linked to its
            wallet page, with both identifiers copyable — instead of a read-only field
            repeating the shortened key twice. Full width rather than the half-width
            field grid the other sections use: the card holds whole 44-char
            identifiers, and half a column forces them to wrap. */}
        <div className="grid gap-1.5">
          <Label>{t("DashboardIssuance.assetDetails.signingWallet")}</Label>
          {signerIdentity ? (
            // Read-only surface — no unsaved state to protect, so the wallet page
            // opens in place.
            <WalletIdentityBadge variant="card" walletLink="same-tab" identity={signerIdentity} />
          ) : (
            // Authority wallets still loading: the pinned walletId alone would render
            // as "Signer unavailable", which is a claim, not a pending state.
            <SkeletonBlock className="h-[7.5rem] rounded-[12px]" />
          )}
          <p className="text-xs text-tertiary">
            {t("DashboardIssuance.assetDetails.signingWalletLockReason")}
          </p>
        </div>
      </FormCard>
    </div>
  );
}
