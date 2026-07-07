"use client";

import { Check, ChevronDown, ExternalLink, Lock } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { getAssetTypeLabel, getCategoryLabel } from "./asset-taxonomy";
import { getDefaultPublicFields, getPublicFieldCandidates } from "./draft-mapping";
import type { DraftState } from "./issuance-draft-wizard.types";

interface StaticField {
  key: string;
  label: string;
  value: string;
}

// Human filename for a logo URL (falls back to the raw value).
function fileName(url: string): string {
  const trimmed = url.trim();
  const fromPath = (path: string) => path.split("/").filter(Boolean).pop() ?? "";
  try {
    return fromPath(new URL(trimmed).pathname) || trimmed;
  } catch {
    return fromPath(trimmed) || trimmed;
  }
}

// The public-vs-private projection shared by the creation wizard (Step 3) and
// the asset management workspace (Public information tab). A live preview of the
// public asset card sits beside an interactive checklist: core identity fields
// are always public (locked), optional asset.* fields can be toggled, and
// non-default optional fields live under a collapse. When `onToggleField` is
// omitted the checklist renders read-only.
export function PublicInfoPreview({
  draft,
  onToggleField,
  disabled,
}: {
  draft: DraftState;
  onToggleField?: (path: string, enabled: boolean) => void;
  disabled?: boolean;
}) {
  const [showOptional, setShowOptional] = useState(false);
  const categoryLabel = getCategoryLabel(draft.assetCategory);
  const typeLabel = getAssetTypeLabel(draft.assetCategory, draft.assetType);

  // Core identity + classification: inherent to the token / served from the
  // token record, so always public and not toggleable.
  const alwaysPublic: StaticField[] = [
    {
      key: "name",
      label: "Name",
      value: draft.name.trim() || "Untitled asset",
    },
    draft.symbol.trim() ? { key: "symbol", label: "Symbol", value: draft.symbol.trim() } : null,
    draft.description.trim()
      ? {
          key: "description",
          label: "Description",
          value: draft.description.trim(),
        }
      : null,
    { key: "decimals", label: "Decimals", value: draft.decimals.trim() || "—" },
    categoryLabel ? { key: "category", label: "Category", value: categoryLabel } : null,
    typeLabel ? { key: "type", label: "Asset type", value: typeLabel } : null,
    draft.imageUrl.trim() ? { key: "logo", label: "Logo", value: fileName(draft.imageUrl) } : null,
  ].filter((field): field is StaticField => Boolean(field));

  // Optional asset.* fields whose public/private state the issuer controls.
  const candidates = getPublicFieldCandidates(draft);
  const enabledCandidates = candidates.filter((candidate) => candidate.enabled);
  const defaultPaths = new Set(
    draft.assetCategory && draft.assetType
      ? getDefaultPublicFields(draft.assetCategory, draft.assetType)
      : []
  );
  const defaultInteractive = candidates.filter((candidate) => defaultPaths.has(candidate.path));
  const optionalInteractive = candidates.filter((candidate) => !defaultPaths.has(candidate.path));

  // Preview facts: fixed identity facts plus every currently-public optional
  // field, so hiding a field also removes it from the preview.
  const facts: { label: string; value: string; href?: string }[] = [
    draft.symbol.trim() ? { label: "Symbol", value: draft.symbol.trim() } : null,
    { label: "Decimals", value: draft.decimals.trim() || "—" },
    categoryLabel ? { label: "Category", value: categoryLabel } : null,
    typeLabel ? { label: "Asset type", value: typeLabel } : null,
    ...enabledCandidates.map((candidate) => ({
      label: candidate.label,
      value: candidate.value,
      href: candidate.path === "asset.website" ? candidate.value : undefined,
    })),
  ].filter((fact): fact is { label: string; value: string; href?: string } => Boolean(fact));

  const toggle = onToggleField
    ? (path: string, next: boolean) => onToggleField(path, next)
    : undefined;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-medium text-[#1c1c1d]">Public token information</h3>
        <p className="mt-0.5 text-sm text-[rgba(28,28,29,0.58)]">
          This information is safe to share and will be served from your asset&apos;s public page.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Preview — how the asset appears publicly. */}
        <div>
          <p className="mb-2 text-sm font-medium text-[#1c1c1d]">Preview</p>
          <div className="rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white p-5">
            <div className="flex items-start gap-4">
              {draft.imageUrl.trim() ? (
                // biome-ignore lint/performance/noImgElement: user-supplied external logo URL; next/image can't be configured for arbitrary hosts here.
                <img
                  src={draft.imageUrl}
                  alt={`${draft.name || "Asset"} logo`}
                  className="h-14 w-14 shrink-0 rounded-full border border-[rgba(28,28,29,0.1)] object-cover"
                />
              ) : (
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.05)] text-xl font-semibold text-[#1c1c1d]">
                  {draft.symbol.slice(0, 1).toUpperCase() || "?"}
                </div>
              )}
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="text-lg leading-tight font-semibold tracking-tight text-[#1c1c1d]">
                    {draft.name.trim() || "Untitled asset"}
                  </h4>
                  {draft.symbol.trim() ? (
                    <span className="rounded-full border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.03)] px-2 py-0.5 text-xs font-medium text-[rgba(28,28,29,0.7)]">
                      {draft.symbol.trim()}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>

            <p
              className={cn(
                "mt-3 text-sm leading-relaxed",
                draft.description.trim()
                  ? "text-[rgba(28,28,29,0.62)]"
                  : "text-[rgba(28,28,29,0.4)]"
              )}
            >
              {draft.description.trim() || "No public description"}
            </p>

            <dl className="mt-4 space-y-2.5 border-t border-[rgba(28,28,29,0.08)] pt-4">
              {facts.map((fact) => (
                <div key={fact.label} className="flex items-center justify-between gap-4">
                  <dt className="shrink-0 text-sm text-[rgba(28,28,29,0.55)]">{fact.label}</dt>
                  <dd className="min-w-0 text-right text-sm font-medium text-[#1c1c1d]">
                    {fact.href ? (
                      <a
                        href={fact.href}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex max-w-full items-center gap-1 truncate hover:underline"
                      >
                        <span className="truncate">{fact.value}</span>
                        <ExternalLink className="h-3 w-3 shrink-0" />
                      </a>
                    ) : (
                      <span className="block truncate">{fact.value}</span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>

        {/* Checklist — what's public, with interactive toggles. */}
        <div>
          <p className="text-sm font-medium text-[#1c1c1d]">Included in public view</p>

          <div className="mt-3 divide-y divide-[rgba(28,28,29,0.06)] rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white px-4">
            {alwaysPublic.map((field) => (
              <FieldRow key={field.key} label={field.label} value={field.value} checked locked />
            ))}
            {defaultInteractive.map((candidate) => (
              <FieldRow
                key={candidate.path}
                label={candidate.label}
                value={candidate.value}
                checked={candidate.enabled}
                disabled={disabled}
                onToggle={toggle ? () => toggle(candidate.path, !candidate.enabled) : undefined}
              />
            ))}
          </div>

          {optionalInteractive.length > 0 ? (
            <div className="mt-3 overflow-hidden rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white">
              <button
                type="button"
                onClick={() => setShowOptional((value) => !value)}
                aria-expanded={showOptional}
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-[rgba(28,28,29,0.02)]"
              >
                <div className="flex items-start gap-2">
                  <Lock className="mt-0.5 h-4 w-4 shrink-0 text-[rgba(28,28,29,0.5)]" />
                  <div>
                    <p className="text-sm font-medium text-[#1c1c1d]">Not included by default</p>
                    <p className="text-sm text-[rgba(28,28,29,0.55)]">
                      These fields stay private unless you choose to include them.
                    </p>
                  </div>
                </div>
                <ChevronDown
                  className={cn(
                    "h-4 w-4 shrink-0 text-[rgba(28,28,29,0.5)] transition-transform",
                    showOptional && "rotate-180"
                  )}
                />
              </button>
              {showOptional ? (
                <div className="divide-y divide-[rgba(28,28,29,0.06)] border-t border-[rgba(28,28,29,0.08)] px-4">
                  {optionalInteractive.map((candidate) => (
                    <FieldRow
                      key={candidate.path}
                      label={candidate.label}
                      value={candidate.value}
                      checked={candidate.enabled}
                      disabled={disabled}
                      onToggle={
                        toggle ? () => toggle(candidate.path, !candidate.enabled) : undefined
                      }
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FieldRow({
  label,
  value,
  checked,
  onToggle,
  locked,
  disabled,
}: {
  label: string;
  value: string;
  checked: boolean;
  onToggle?: () => void;
  locked?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start gap-3 py-3">
      <RoundCheck checked={checked} onToggle={onToggle} locked={locked} disabled={disabled} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-[#1c1c1d]">{label}</p>
        {value ? (
          <p className="mt-0.5 break-words text-sm text-[rgba(28,28,29,0.55)]">{value}</p>
        ) : null}
      </div>
      {locked ? (
        <span
          title="Always public"
          className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center text-[rgba(28,28,29,0.3)]"
        >
          <Lock className="h-3.5 w-3.5" />
        </span>
      ) : null}
    </div>
  );
}

function RoundCheck({
  checked,
  onToggle,
  locked,
  disabled,
}: {
  checked: boolean;
  onToggle?: () => void;
  locked?: boolean;
  disabled?: boolean;
}) {
  const base = cn(
    "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors",
    checked
      ? "border-[#0f0f10] bg-[#0f0f10] text-white"
      : "border-[rgba(28,28,29,0.28)] bg-white text-transparent"
  );

  if (!onToggle || locked || disabled) {
    return (
      <span
        className={cn(base, disabled && "opacity-60")}
        aria-hidden="true"
        aria-disabled={disabled}
      >
        <Check className="h-3 w-3" strokeWidth={3} />
      </span>
    );
  }

  return (
    <button
      type="button"
      aria-pressed={checked}
      aria-disabled={disabled}
      aria-label={checked ? "Public — hide this field" : "Hidden — show this field publicly"}
      onClick={onToggle}
      className={cn(
        base,
        "cursor-pointer hover:border-[#0f0f10]",
        !checked && "hover:bg-[rgba(28,28,29,0.04)]"
      )}
    >
      <Check className="h-3 w-3" strokeWidth={3} />
    </button>
  );
}
