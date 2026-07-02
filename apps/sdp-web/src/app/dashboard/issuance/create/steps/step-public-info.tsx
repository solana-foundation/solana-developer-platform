"use client";

import {
  Braces,
  CircleCheck,
  ExternalLink,
  FileText,
  Landmark,
  Lock,
  type LucideIcon,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { motion } from "motion/react";
import { accessControlLabel } from "../asset-details-config";
import { getAssetTypeLabel, getCategoryLabel } from "../asset-taxonomy";
import { getPublicProjection } from "../draft-mapping";
import { CAPACITY_KEYS } from "../issuance-draft-wizard.types";
import { useIssuanceDraft } from "../use-issuance-draft";

interface PrivateItem {
  icon: LucideIcon;
  label: string;
  description: string;
}

export function StepPublicInfo() {
  const { draft } = useIssuanceDraft();
  const categoryLabel = getCategoryLabel(draft.assetCategory);
  const typeLabel = getAssetTypeLabel(draft.assetCategory, draft.assetType);

  // Token identity + classification are always public; registry projection adds
  // the type-specific public asset fields (issuer, peg, …). We only need the
  // field *names* here — the hero preview already shows their values.
  const baseLabels: (string | null)[] = [
    "Name",
    "Symbol",
    draft.description ? "Description" : null,
    "Decimals",
    categoryLabel ? "Category" : null,
    typeLabel ? "Asset type" : null,
    draft.website ? "Website" : null,
  ];
  const projectionExtras = getPublicProjection(draft)
    .filter(
      (field) =>
        field.present && !["asset.name", "asset.description", "chain.decimals"].includes(field.path)
    )
    .map((field) => field.label);
  const publicLabels = [...baseLabels, ...projectionExtras].filter((label): label is string =>
    Boolean(label)
  );

  const anyCapacity = CAPACITY_KEYS.some((key) => draft.capacities[key]);
  const documentCount = draft.documents.filter((doc) => doc.name.trim() || doc.url.trim()).length;
  const customFieldCount = draft.customFields.filter((field) => field.key.trim()).length;
  const privateItems: PrivateItem[] = [
    draft.accessControl
      ? {
          icon: ShieldCheck,
          label: "Access control",
          description: accessControlLabel(draft.accessControl) ?? "Transfer restrictions",
        }
      : null,
    anyCapacity
      ? {
          icon: SlidersHorizontal,
          label: "Advanced capacities",
          description: "KYC, freeze, approvals & reporting",
        }
      : null,
    draft.reserveCustodian.trim()
      ? { icon: Landmark, label: "Reserve custodian", description: draft.reserveCustodian.trim() }
      : null,
    documentCount > 0
      ? {
          icon: FileText,
          label: "Documents & references",
          description: `${documentCount} attached`,
        }
      : null,
    customFieldCount > 0
      ? {
          icon: Braces,
          label: "Custom fields",
          description: `${customFieldCount} field${customFieldCount === 1 ? "" : "s"}`,
        }
      : null,
  ].filter((item): item is PrivateItem => Boolean(item));

  return (
    <motion.div
      key="public-info"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="space-y-5"
    >
      <div>
        <h2 className="text-2xl font-medium text-[#1c1c1d]">Public information</h2>
        <p className="mt-1.5 text-sm text-[rgba(28,28,29,0.62)]">
          This is how your asset will appear to wallets, explorers, and the public.
        </p>
      </div>

      {/* Hero preview — identity + facts side by side to fill the width */}
      <div className="rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white p-6">
        <div className="grid gap-6 md:grid-cols-2">
          <div className="flex items-start gap-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[rgba(28,28,29,0.06)] text-xl font-semibold text-[#1c1c1d]">
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
              <p
                className={
                  draft.description
                    ? "mt-2 text-sm text-[rgba(28,28,29,0.62)]"
                    : "mt-2 text-sm text-[rgba(28,28,29,0.4)]"
                }
              >
                {draft.description || "No public description"}
              </p>
            </div>
          </div>

          <div className="space-y-1 md:border-l md:border-[rgba(28,28,29,0.08)] md:pl-6">
            <PreviewRow label="Symbol" value={draft.symbol} />
            <PreviewRow label="Decimals" value={draft.decimals} />
            <PreviewRow label="Category" value={categoryLabel} />
            <PreviewRow label="Asset type" value={typeLabel} />
            <PreviewRow label="Website" value={draft.website} />
          </div>
        </div>
      </div>

      {/* Public vs private — two balanced columns */}
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white p-5">
          <div className="flex items-center gap-2">
            <CircleCheck className="h-4 w-4 text-[#0c804c]" />
            <p className="text-base font-medium text-[#1c1c1d]">Included in public view</p>
          </div>
          <p className="mt-0.5 text-sm text-[rgba(28,28,29,0.58)]">
            Visible to wallets, explorers, and anyone who looks up the token.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {publicLabels.map((label) => (
              <span
                key={label}
                className="inline-flex items-center gap-1.5 rounded-full border border-[rgba(12,128,76,0.2)] bg-[rgba(12,128,76,0.06)] px-3 py-1.5 text-sm font-medium text-[#0c804c]"
              >
                <CircleCheck className="h-3.5 w-3.5" />
                {label}
              </span>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white p-5">
          <div className="flex items-center gap-2">
            <Lock className="h-4 w-4 text-[rgba(28,28,29,0.55)]" />
            <p className="text-base font-medium text-[#1c1c1d]">Kept private</p>
          </div>
          <p className="mt-0.5 text-sm text-[rgba(28,28,29,0.58)]">
            Stored securely and never shown publicly unless you choose to.
          </p>
          {privateItems.length > 0 ? (
            <ul className="mt-4 space-y-2.5">
              {privateItems.map((item) => {
                const Icon = item.icon;
                return (
                  <li
                    key={item.label}
                    className="flex items-center gap-3 rounded-xl border border-[rgba(28,28,29,0.08)] bg-[rgba(28,28,29,0.02)] px-3 py-2.5"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[rgba(28,28,29,0.05)] text-[rgba(28,28,29,0.7)]">
                      <Icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-[#1c1c1d]">{item.label}</p>
                      <p className="truncate text-xs text-[rgba(28,28,29,0.55)]">
                        {item.description}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="mt-4 flex items-center gap-2 rounded-xl border border-dashed border-[rgba(28,28,29,0.14)] px-3 py-5 text-sm text-[rgba(28,28,29,0.5)]">
              <Lock className="h-4 w-4 shrink-0" />
              No private details configured yet.
            </div>
          )}
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
