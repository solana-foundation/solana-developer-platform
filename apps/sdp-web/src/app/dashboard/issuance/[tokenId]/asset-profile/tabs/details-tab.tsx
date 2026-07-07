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
  "Financial details": DollarSign,
  "Security details": ScrollText,
  "Asset details": Boxes,
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
    ? getSignerWalletOptionLabel(signerWallet)
    : draft.signingWalletId || "Project default signer";

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <p className="inline-flex items-center gap-1.5 text-sm text-[rgba(28,28,29,0.55)]">
          <Lock className="h-3.5 w-3.5 shrink-0" />
          This information is private by default and won&apos;t be visible to the public unless you
          choose to include it.
        </p>
        <MetadataJsonToggle open={jsonOpen} onToggle={() => setJsonOpen((prev) => !prev)} />
      </div>

      {jsonOpen ? <MetadataJsonPanel metadata={buildIssuanceMetadata(draft)} /> : null}

      <FormCard
        title="About this asset"
        description="Basic information that describes what this asset is."
        icon={Tag}
      >
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <TextField
            label="Name"
            required
            disabled={saving}
            value={draft.name}
            onChange={(value) => updateDraft({ name: value })}
            placeholder="e.g., Verde Dollar"
            error={nameError}
          />
          <div className="grid grid-cols-2 items-start gap-4">
            <ReadOnlyField label="Symbol" value={token.symbol} lockReason="Locked after creation" />
            <ReadOnlyField
              label="Decimals"
              value={String(token.decimals)}
              lockReason="Locked after creation"
            />
          </div>
        </div>
        <div className="mt-4 grid gap-1.5">
          <Label htmlFor="asset-description">
            Description{" "}
            <span aria-hidden className="text-[#c71f37]">
              *
            </span>
            <span className="sr-only"> (required)</span>
          </Label>
          <textarea
            id="asset-description"
            disabled={saving}
            value={draft.description}
            onChange={(event) => updateDraft({ description: event.currentTarget.value })}
            rows={3}
            placeholder="Describe what this asset represents."
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
            label="Website"
            disabled={saving}
            value={draft.website}
            onChange={(value) => updateDraft({ website: value })}
            placeholder="https://…"
            error={fieldError("website")}
          />
          <TextField
            label="Logo image URL"
            disabled={saving}
            value={draft.imageUrl}
            onChange={(value) => updateDraft({ imageUrl: value })}
            placeholder="https://…/logo.png"
            help="Shown next to your token in wallets and explorers."
            error={fieldError("imageUrl")}
          />
        </div>
      </FormCard>

      {sections.map((section) => (
        <FormCard
          key={section.title}
          title={section.title}
          description={section.description}
          icon={SECTION_ICONS[section.title]}
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
        title="Documents & references"
        description="Important documents and references related to this asset."
        icon={FileText}
      >
        <DocumentRows
          documents={draft.documents}
          onChange={(documents) => updateDraft({ documents })}
          disabled={saving}
        />
      </FormCard>

      <FormCard
        title="Custom fields"
        description="Your own private fields, stored under custom.customer."
        icon={Braces}
      >
        <CustomFieldRows
          fields={draft.customFields}
          onChange={(customFields) => updateDraft({ customFields })}
          disabled={saving}
        />
      </FormCard>

      <FormCard
        title="Operational"
        description="Operational settings for this asset."
        icon={SlidersHorizontal}
      >
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <ReadOnlyField
            label="Signing wallet"
            value={signerLabel}
            lockReason="Set at creation — individual operations can use a different signer."
          />
          <TextField
            label="Metadata URI (optional)"
            disabled={saving}
            value={draft.metadataUri}
            onChange={(value) => updateDraft({ metadataUri: value })}
            placeholder="https://…/metadata.json"
            help="Leave blank to use SDP-hosted metadata."
          />
        </div>
      </FormCard>
    </div>
  );
}
