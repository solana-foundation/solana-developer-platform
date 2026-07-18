"use client";

import { DEFAULT_SDP_DOCS_URL, type PaymentsDashboardWallet } from "@sdp/types";
import { Tab, TabList, Tabs } from "@solana/design-system/tabs";
import { ExternalLink } from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Select, SelectItem } from "@/components/ui/select";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { TokenSignerSelect } from "../../[tokenId]/token-signer-select";
import { AdvancedCapacities } from "../advanced-capacities";
import { AdvancedSettingsEditor } from "../advanced-settings-editor";
import { ACCESS_CONTROL_OPTIONS, getCategorySections } from "../asset-details-config";
import { DocumentRows } from "../document-rows";
import {
  buildIssuanceMetadata,
  getAssetDetailsErrors,
  getRequiredAssetDetailKeys,
} from "../draft-mapping";
import { CustomFieldRows, DetailField, FormCard, TextField } from "../form-primitives";
import type { DraftState } from "../issuance-draft-wizard.types";
import { MetadataJsonPanel, MetadataJsonToggle } from "../metadata-json";
import { useIssuanceDraft } from "../use-issuance-draft";

const TAB_IDS = ["overview", "compliance", "operational", "custom"] as const;

// Docs deep-links (mirrors the docsHref env pattern used in the dashboard shell).
const DOCS_BASE =
  process.env.NEXT_PUBLIC_SDP_DOCS_URL ||
  (process.env.NODE_ENV === "development" ? "http://localhost:3001/docs" : DEFAULT_SDP_DOCS_URL);
const ACCESS_CONTROL_DOCS_HREF = `${DOCS_BASE}/tokens/allowlists`;

function DocsLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs font-medium text-tertiary underline-offset-2 transition-colors hover:text-primary hover:underline"
    >
      {children}
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}

export function StepAssetDetails({
  signerWallets,
  signerWalletsError,
  showErrors,
}: {
  signerWallets: PaymentsDashboardWallet[];
  signerWalletsError: string | null;
  showErrors: boolean;
}) {
  const t = useTranslations();
  const tabs = [
    { id: TAB_IDS[0], label: t("DashboardIssuance.assetDetails.tabs.overview") },
    { id: TAB_IDS[1], label: t("DashboardIssuance.assetDetails.tabs.compliance") },
    { id: TAB_IDS[2], label: t("DashboardIssuance.assetDetails.tabs.operational") },
    { id: TAB_IDS[3], label: t("DashboardIssuance.assetDetails.tabs.custom") },
  ];
  const { draft, updateDraft } = useIssuanceDraft();
  const [tab, setTab] = useState<string>("overview");
  const [jsonOpen, setJsonOpen] = useState(false);
  const sections = getCategorySections(draft.assetCategory);
  const metadata = buildIssuanceMetadata(draft);
  const errors = getAssetDetailsErrors(draft, t);
  const requiredKeys = getRequiredAssetDetailKeys(draft);
  const hasErrors = Object.keys(errors).length > 0;

  // Surface a field's error once the user has typed into it (live format
  // feedback) or once they've attempted to continue (revealing still-empty
  // required fields). Keeps the form quiet on first load, then guides on submit.
  const fieldError = (key: keyof DraftState): string | undefined => {
    const message = errors[key];
    if (!message) {
      return undefined;
    }
    const hasContent = String(draft[key] ?? "").trim().length > 0;
    return hasContent || showErrors ? message : undefined;
  };
  const descriptionError = fieldError("description");

  // A failed continue attempt highlights fields that all live on the Overview
  // tab — jump there so the user can see what needs fixing.
  useEffect(() => {
    if (showErrors && hasErrors) {
      setTab("overview");
    }
  }, [showErrors, hasErrors]);

  return (
    <motion.div
      key="asset-details-form"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="space-y-6"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-medium text-primary">
            {t("DashboardIssuance.assetDetails.title")}
          </h2>
          <p className="mt-1.5 text-sm text-secondary">
            {t("DashboardIssuance.assetDetails.description")}
          </p>
        </div>
        <MetadataJsonToggle open={jsonOpen} onToggle={() => setJsonOpen((prev) => !prev)} />
      </div>

      {jsonOpen ? <MetadataJsonPanel metadata={metadata} /> : null}

      <Tabs bordered value={tab} onValueChange={(value) => setTab(value)}>
        <TabList className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {tabs.map((entry) => (
            <Tab key={entry.id} value={entry.id} className="shrink-0 whitespace-nowrap">
              {entry.label}
            </Tab>
          ))}
        </TabList>
      </Tabs>

      {tab === "overview" ? (
        <div className="space-y-5">
          <FormCard
            title={t("DashboardIssuance.assetDetails.about")}
            description={t("DashboardIssuance.assetDetails.aboutDescription")}
          >
            <div className="grid items-start gap-4 sm:grid-cols-2">
              <TextField
                label={t("DashboardIssuance.create.symbol")}
                required
                value={draft.symbol}
                onChange={(value) => updateDraft({ symbol: value })}
                placeholder={t("DashboardIssuance.assetDetails.symbolPlaceholder")}
                error={fieldError("symbol")}
              />
              <TextField
                label={t("DashboardIssuance.create.decimals")}
                required
                type="number"
                value={draft.decimals}
                onChange={(value) => updateDraft({ decimals: value })}
                placeholder={t("DashboardIssuance.create.decimalsPlaceholder")}
                error={fieldError("decimals")}
              />
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
                value={draft.description}
                onChange={(event) => updateDraft({ description: event.currentTarget.value })}
                rows={3}
                placeholder={t("DashboardIssuance.assetDetails.descriptionPlaceholder")}
                aria-invalid={descriptionError ? true : undefined}
                className={cn(
                  "w-full rounded-[14px] border bg-white px-4 py-3 text-sm text-primary outline-none transition-[box-shadow,border-color] placeholder:text-muted",
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
                value={draft.website}
                onChange={(value) => updateDraft({ website: value })}
                placeholder={t("DashboardIssuance.assetDetails.websitePlaceholder")}
                error={fieldError("website")}
              />
              <TextField
                label={t("DashboardIssuance.assetDetails.logoImageUrl")}
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
            >
              <div className="grid items-start gap-4 sm:grid-cols-2">
                {section.fields.map((field) => (
                  <DetailField
                    key={field.key}
                    field={field}
                    draft={draft}
                    updateDraft={updateDraft}
                    required={requiredKeys.has(field.key)}
                    error={fieldError(field.key)}
                  />
                ))}
              </div>
            </FormCard>
          ))}

          <FormCard
            title={t("DashboardIssuance.assetDetails.documents")}
            description={t("DashboardIssuance.assetDetails.documentsDescription")}
          >
            <DocumentRows
              documents={draft.documents}
              onChange={(documents) => updateDraft({ documents })}
            />
          </FormCard>
        </div>
      ) : null}

      {tab === "compliance" ? (
        <div className="space-y-5">
          <FormCard
            title={t("DashboardIssuance.compliance.accessControl")}
            description={t("DashboardIssuance.assetDetails.accessControlDescription")}
          >
            <div className="max-w-xs">
              <Label>{t("DashboardIssuance.compliance.accessControl")}</Label>
              <div className="mt-1.5">
                <Select
                  value={draft.accessControl || null}
                  onValueChange={(value) =>
                    updateDraft({ accessControl: (value ?? "") as DraftState["accessControl"] })
                  }
                  placeholder={t("DashboardIssuance.compliance.selectAccessControl")}
                >
                  {ACCESS_CONTROL_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </SelectItem>
                  ))}
                </Select>
              </div>
            </div>
            <div className="mt-3">
              <DocsLink href={ACCESS_CONTROL_DOCS_HREF}>
                {t("DashboardIssuance.assetDetails.learnLists")}
              </DocsLink>
            </div>
          </FormCard>
          <AdvancedSettingsEditor
            category={draft.assetCategory}
            type={draft.assetType}
            value={draft.advancedSettings}
            onChange={(advancedSettings) => updateDraft({ advancedSettings })}
          />
          <AdvancedCapacities
            value={draft.capacities}
            onChange={(key, checked) =>
              updateDraft({ capacities: { ...draft.capacities, [key]: checked } })
            }
          />
        </div>
      ) : null}

      {tab === "operational" ? (
        <FormCard
          title={t("DashboardIssuance.assetDetails.operational")}
          description={t("DashboardIssuance.assetDetails.operationalDescription")}
        >
          <div>
            <TokenSignerSelect
              signerWallets={signerWallets}
              signerWalletId={draft.signingWalletId}
              signerUnavailableReason={signerWalletsError}
              onSignerWalletIdChange={(value) => updateDraft({ signingWalletId: value })}
              label={t("DashboardIssuance.assetDetails.signingWallet")}
              showSelectionSummary
              optional
            />
            {/* Signer is optional at draft stage — clarify the fallback only
                when a choice is actually possible (more than one wallet) and
                none is made. The 0-wallet and single-wallet cases show their
                own message inside the field. */}
            {!signerWalletsError && signerWallets.length > 1 && !draft.signingWalletId.trim() ? (
              <p className="mt-1.5 text-xs text-tertiary">
                {t("DashboardIssuance.assetDetails.optionalSignerHint")}
              </p>
            ) : null}
          </div>
        </FormCard>
      ) : null}

      {tab === "custom" ? (
        <FormCard
          title={t("DashboardIssuance.assetDetails.customFields")}
          description={t("DashboardIssuance.assetDetails.customFieldsDescription")}
        >
          <CustomFieldRows
            fields={draft.customFields}
            onChange={(customFields) => updateDraft({ customFields })}
          />
        </FormCard>
      ) : null}
    </motion.div>
  );
}
