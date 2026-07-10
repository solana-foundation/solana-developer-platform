"use client";

import { DEFAULT_SDP_DOCS_URL, type PaymentsDashboardWallet } from "@sdp/types";
import { Tab, TabList, Tabs } from "@solana/design-system/tabs";
import { ExternalLink } from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Select, SelectItem } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { TokenSignerSelect } from "../../[tokenId]/token-signer-select";
import { AdvancedCapacities } from "../advanced-capacities";
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

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "compliance", label: "Compliance & Access" },
  { id: "operational", label: "Operational" },
  { id: "custom", label: "Custom fields" },
] as const;

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
  const { draft, updateDraft } = useIssuanceDraft();
  const [tab, setTab] = useState<string>("overview");
  const [jsonOpen, setJsonOpen] = useState(false);
  const sections = getCategorySections(draft.assetCategory);
  const metadata = buildIssuanceMetadata(draft);
  const errors = getAssetDetailsErrors(draft);
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
          <h2 className="text-2xl font-medium text-primary">Asset details</h2>
          <p className="mt-1.5 text-sm text-secondary">
            Add the key information about this asset. You can update these details any time.
          </p>
        </div>
        <MetadataJsonToggle open={jsonOpen} onToggle={() => setJsonOpen((prev) => !prev)} />
      </div>

      {jsonOpen ? <MetadataJsonPanel metadata={metadata} /> : null}

      <Tabs bordered value={tab} onValueChange={(value) => setTab(value)}>
        <TabList className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {TABS.map((entry) => (
            <Tab key={entry.id} value={entry.id} className="shrink-0 whitespace-nowrap">
              {entry.label}
            </Tab>
          ))}
        </TabList>
      </Tabs>

      {tab === "overview" ? (
        <div className="space-y-5">
          <FormCard
            title="About this asset"
            description="Basic information that describes what this asset is."
          >
            <div className="grid items-start gap-4 sm:grid-cols-2">
              <TextField
                label="Symbol"
                required
                value={draft.symbol}
                onChange={(value) => updateDraft({ symbol: value })}
                placeholder="e.g., vUSD"
                error={fieldError("symbol")}
              />
              <TextField
                label="Decimals"
                required
                type="number"
                value={draft.decimals}
                onChange={(value) => updateDraft({ decimals: value })}
                placeholder="e.g., 6"
                error={fieldError("decimals")}
              />
            </div>
            <div className="mt-4 grid gap-1.5">
              <Label htmlFor="asset-description">
                Description{" "}
                <span aria-hidden className="text-destructive">
                  *
                </span>
                <span className="sr-only"> (required)</span>
              </Label>
              <textarea
                id="asset-description"
                value={draft.description}
                onChange={(event) => updateDraft({ description: event.currentTarget.value })}
                rows={3}
                placeholder="Describe what this asset represents."
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
                label="Website"
                value={draft.website}
                onChange={(value) => updateDraft({ website: value })}
                placeholder="https://…"
                error={fieldError("website")}
              />
              <TextField
                label="Logo image URL"
                value={draft.imageUrl}
                onChange={(value) => updateDraft({ imageUrl: value })}
                placeholder="https://…/logo.png"
                help="Shown next to your token in wallets and explorers."
                error={fieldError("imageUrl")}
              />
            </div>
          </FormCard>

          {sections.map((section) => (
            <FormCard key={section.title} title={section.title} description={section.description}>
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
            title="Documents & references"
            description="Important documents and references related to this asset."
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
            title="Access control"
            description="Choose how this token treats approved or blocked destination addresses."
          >
            <div className="max-w-xs">
              <Label>Access control</Label>
              <div className="mt-1.5">
                <Select
                  value={draft.accessControl || null}
                  onValueChange={(value) =>
                    updateDraft({ accessControl: (value ?? "") as DraftState["accessControl"] })
                  }
                  placeholder="Select access control"
                >
                  {ACCESS_CONTROL_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </Select>
              </div>
            </div>
            <div className="mt-3">
              <DocsLink href={ACCESS_CONTROL_DOCS_HREF}>
                Learn how allow and block lists differ
              </DocsLink>
            </div>
          </FormCard>
          <AdvancedCapacities
            value={draft.capacities}
            onChange={(key, checked) =>
              updateDraft({ capacities: { ...draft.capacities, [key]: checked } })
            }
          />
        </div>
      ) : null}

      {tab === "operational" ? (
        <FormCard title="Operational" description="Optional operational settings.">
          <div>
            <TokenSignerSelect
              signerWallets={signerWallets}
              signerWalletId={draft.signingWalletId}
              signerUnavailableReason={signerWalletsError}
              onSignerWalletIdChange={(value) => updateDraft({ signingWalletId: value })}
              label="Signing wallet"
              showSelectionSummary
              optional
            />
            {/* Signer is optional at draft stage — clarify the fallback only
                when a choice is actually possible (more than one wallet) and
                none is made. The 0-wallet and single-wallet cases show their
                own message inside the field. */}
            {!signerWalletsError && signerWallets.length > 1 && !draft.signingWalletId.trim() ? (
              <p className="mt-1.5 text-xs text-tertiary">
                Optional — leave unselected to use the project&apos;s default signer.
              </p>
            ) : null}
          </div>
        </FormCard>
      ) : null}

      {tab === "custom" ? (
        <FormCard
          title="Custom fields"
          description="Add your own private fields, stored under custom.customer."
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
