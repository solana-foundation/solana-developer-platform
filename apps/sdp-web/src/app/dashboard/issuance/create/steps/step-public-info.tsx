"use client";

import { ChevronDown, CircleCheck, ExternalLink, Lock } from "lucide-react";
import { motion } from "motion/react";
import { getAssetTypeLabel, getCategoryLabel } from "../asset-taxonomy";
import { getPublicProjection } from "../draft-mapping";
import { CAPACITY_KEYS } from "../issuance-draft-wizard.types";
import { useIssuanceDraft } from "../use-issuance-draft";

interface PublicItem {
  label: string;
  value: string;
}

export function StepPublicInfo() {
  const { draft } = useIssuanceDraft();
  const categoryLabel = getCategoryLabel(draft.assetCategory);
  const typeLabel = getAssetTypeLabel(draft.assetCategory, draft.assetType);

  // Token identity + classification are always public; registry projection adds
  // the type-specific public asset fields (issuer, peg, …).
  const baseItems: (PublicItem | null)[] = [
    { label: "Name", value: draft.name },
    { label: "Symbol", value: draft.symbol },
    draft.description ? { label: "Description (public)", value: draft.description } : null,
    { label: "Decimals", value: draft.decimals },
    categoryLabel ? { label: "Category", value: categoryLabel } : null,
    typeLabel ? { label: "Asset type", value: typeLabel } : null,
    draft.website ? { label: "Website", value: draft.website } : null,
  ];
  const projectionExtras: PublicItem[] = getPublicProjection(draft)
    .filter(
      (field) =>
        field.present && !["asset.name", "asset.description", "chain.decimals"].includes(field.path)
    )
    .map((field) => ({ label: field.label, value: String(field.value) }));
  const included = [...baseItems, ...projectionExtras].filter((item): item is PublicItem =>
    Boolean(item)
  );

  const anyCapacity = CAPACITY_KEYS.some((key) => draft.capacities[key]);
  const privateItems = [
    draft.accessControl ? "Access control settings" : null,
    anyCapacity ? "Advanced capacities" : null,
    draft.reserveCustodian.trim() ? "Reserve custodian" : null,
    draft.documents.some((doc) => doc.name.trim() || doc.url.trim())
      ? "Documents & references"
      : null,
    draft.customFields.some((field) => field.key.trim()) ? "Custom fields" : null,
  ].filter((item): item is string => Boolean(item));

  return (
    <motion.div
      key="public-info"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="space-y-6"
    >
      <div>
        <h2 className="text-2xl font-medium text-[#1c1c1d]">Public information</h2>
        <p className="mt-1.5 text-sm text-[rgba(28,28,29,0.62)]">
          This is how your asset will appear to wallets, explorers, and the public. Only the fields
          below will be visible.
        </p>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        {/* Preview */}
        <div className="rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white p-5">
          <p className="text-xs font-medium tracking-wide text-[rgba(28,28,29,0.5)]">Preview</p>
          <div className="mt-4 flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[rgba(28,28,29,0.06)] text-lg font-semibold text-[#1c1c1d]">
              {draft.symbol.slice(0, 1).toUpperCase() || "?"}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="truncate text-lg font-medium text-[#1c1c1d]">
                  {draft.name || "Untitled asset"}
                </h3>
                {draft.symbol ? (
                  <span className="rounded-full bg-[rgba(28,28,29,0.08)] px-2 py-0.5 text-xs font-medium text-[rgba(28,28,29,0.7)]">
                    {draft.symbol}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
          {draft.description ? (
            <p className="mt-3 text-sm text-[rgba(28,28,29,0.62)]">{draft.description}</p>
          ) : null}
          <div className="mt-4 space-y-1">
            <PreviewRow label="Symbol" value={draft.symbol} />
            <PreviewRow label="Decimals" value={draft.decimals} />
            <PreviewRow label="Category" value={categoryLabel} />
            <PreviewRow label="Asset type" value={typeLabel} />
            <PreviewRow label="Website" value={draft.website} />
          </div>
        </div>

        {/* Included / private */}
        <div className="rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white p-5">
          <p className="text-base font-medium text-[#1c1c1d]">Included in public view</p>
          <p className="mt-0.5 text-sm text-[rgba(28,28,29,0.58)]">
            These fields will be shown to the public.
          </p>
          <ul className="mt-4 space-y-3">
            {included.map((item) => (
              <li key={item.label} className="flex items-start gap-2.5">
                <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-success-text,#0c804c)]" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[#1c1c1d]">{item.label}</p>
                  <p className="truncate text-sm text-[rgba(28,28,29,0.6)]">
                    {item.value.trim() ? item.value : "Not set"}
                  </p>
                </div>
              </li>
            ))}
          </ul>

          <details className="group mt-4 rounded-xl border border-[rgba(28,28,29,0.1)] bg-[rgba(28,28,29,0.02)] p-3">
            <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
              <Lock className="h-4 w-4 text-[rgba(28,28,29,0.5)]" />
              <span className="text-sm font-medium text-[#1c1c1d]">Not included by default</span>
              <ChevronDown className="ml-auto h-4 w-4 text-[rgba(28,28,29,0.5)] transition-transform group-open:rotate-180" />
            </summary>
            <p className="mt-2 text-xs text-[rgba(28,28,29,0.58)]">
              These stay private unless you choose to include them.
            </p>
            {privateItems.length > 0 ? (
              <ul className="mt-2 space-y-1">
                {privateItems.map((item) => (
                  <li key={item} className="text-sm text-[rgba(28,28,29,0.7)]">
                    {item}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-[rgba(28,28,29,0.5)]">
                No private fields configured.
              </p>
            )}
          </details>
        </div>
      </div>

      <div className="flex items-start gap-2 rounded-2xl border border-[rgba(28,28,29,0.1)] bg-[rgba(28,28,29,0.02)] px-4 py-3">
        <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-[rgba(28,28,29,0.5)]" />
        <p className="text-sm text-[rgba(28,28,29,0.6)]">
          You can change what&apos;s public at any time from the Public information tab.
        </p>
      </div>
    </motion.div>
  );
}

function PreviewRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-[rgba(28,28,29,0.55)]">{label}</span>
      <span className="min-w-0 truncate text-right font-medium text-[#1c1c1d]">
        {value?.trim() ? value : "—"}
      </span>
    </div>
  );
}
