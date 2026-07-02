"use client";

import {
  ExternalLink,
  FileText,
  Globe,
  Info,
  type LucideIcon,
  Pencil,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { accessControlLabel } from "../asset-details-config";
import { getAssetTypeLabel, getCategoryLabel } from "../asset-taxonomy";
import { getRequiredForDeployWarnings } from "../draft-mapping";
import type { DraftState, WizardStep } from "../issuance-draft-wizard.types";
import { useIssuanceDraft } from "../use-issuance-draft";

interface Field {
  label: string;
  value: string | null;
  hint?: string;
  href?: string | null;
}

interface Section {
  icon: LucideIcon;
  title: string;
  description: string;
  editStep: WizardStep;
  fields: Field[];
}

function accessControlHint(mode: DraftState["accessControl"]): string | undefined {
  switch (mode) {
    case "allowlist":
      return "Only approved addresses can hold or transfer.";
    case "blocklist":
      return "Blocked addresses cannot hold or transfer.";
    default:
      return undefined;
  }
}

export function StepReview() {
  const { draft, goToStep } = useIssuanceDraft();
  const warnings = getRequiredForDeployWarnings(draft);

  const categoryLabel = getCategoryLabel(draft.assetCategory);
  const typeLabel = getAssetTypeLabel(draft.assetCategory, draft.assetType);
  const transferRestrictionsEnabled =
    draft.accessControl === "allowlist" ||
    draft.accessControl === "blocklist" ||
    draft.capacities.transferApprovals;
  const website = draft.website.trim();

  const sections: Section[] = [
    {
      icon: FileText,
      title: "Asset",
      description: "The asset and how it will be represented.",
      editStep: "classification",
      fields: [
        { label: "Asset category", value: categoryLabel },
        { label: "Asset type", value: typeLabel },
        { label: "Name", value: draft.name },
        { label: "Symbol", value: draft.symbol },
      ],
    },
    {
      icon: Info,
      title: "Asset details",
      description: "Key information about the asset.",
      editStep: "asset-details",
      fields: [
        { label: "Description", value: draft.description },
        { label: "Decimals", value: draft.decimals },
        { label: "Website", value: website || null, href: website || null },
      ],
    },
    {
      icon: ShieldCheck,
      title: "Compliance & access",
      description: "How the asset will be controlled and who can interact with it.",
      editStep: "asset-details",
      fields: [
        {
          label: "Access control",
          value: accessControlLabel(draft.accessControl),
          hint: accessControlHint(draft.accessControl),
        },
        {
          label: "Transfer restrictions",
          value: transferRestrictionsEnabled ? "Enabled" : "Disabled",
          hint: transferRestrictionsEnabled
            ? "Transfers limited to approved participants."
            : undefined,
        },
        {
          label: "Investor reporting",
          value: draft.capacities.investorReporting ? "Enabled" : "Disabled",
          hint: draft.capacities.investorReporting
            ? "Activity reports available for investors and stakeholders."
            : undefined,
        },
      ],
    },
    {
      icon: Globe,
      title: "Public information",
      description: "The safe information that will be visible to anyone.",
      editStep: "public-info",
      fields: [
        { label: "Public name", value: draft.name },
        { label: "Public symbol", value: draft.symbol },
        { label: "Description (public)", value: draft.description },
      ],
    },
  ];

  return (
    <motion.div
      key="review"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="space-y-5"
    >
      <div>
        <h2 className="text-2xl font-medium text-[#1c1c1d]">Review &amp; finish</h2>
        <p className="mt-1.5 text-sm text-[rgba(28,28,29,0.62)]">
          Please review all details below. You can edit any section before creating your draft.
        </p>
      </div>

      {warnings.length > 0 ? (
        <div className="flex items-start gap-2.5 rounded-2xl border border-[rgba(234,179,8,0.3)] bg-[rgba(234,179,8,0.08)] px-4 py-3 text-[#92400e]">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 text-sm">
            <p className="font-semibold">Recommended before deploying</p>
            <p className="mt-0.5 opacity-90">
              These aren&apos;t required for a draft but are needed before you can deploy on-chain:{" "}
              {warnings.join(", ")}.
            </p>
          </div>
        </div>
      ) : null}

      {sections.map((section) => (
        <ReviewSection
          key={section.title}
          section={section}
          onEdit={() => goToStep(section.editStep)}
        />
      ))}
    </motion.div>
  );
}

function ReviewSection({ section, onEdit }: { section: Section; onEdit: () => void }) {
  const Icon = section.icon;
  return (
    <div className="rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="flex items-start gap-3 lg:w-56 lg:shrink-0">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[rgba(28,28,29,0.05)] text-[rgba(28,28,29,0.7)]">
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="text-base font-medium text-[#1c1c1d]">{section.title}</p>
            <p className="mt-0.5 text-sm text-[rgba(28,28,29,0.55)]">{section.description}</p>
          </div>
        </div>

        <div className="grid flex-1 gap-x-6 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
          {section.fields.map((field) => (
            <FieldCell key={field.label} field={field} />
          ))}
        </div>

        <div className="lg:shrink-0">
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[rgba(28,28,29,0.12)] px-3 py-1.5 text-sm font-medium text-[rgba(28,28,29,0.75)] transition-colors hover:bg-[rgba(28,28,29,0.04)] hover:text-[#1c1c1d]"
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </button>
        </div>
      </div>
    </div>
  );
}

function FieldCell({ field }: { field: Field }) {
  const hasValue = field.value !== null && field.value.trim().length > 0;
  return (
    <div className="min-w-0">
      <p className="text-xs text-[rgba(28,28,29,0.52)]">{field.label}</p>
      {hasValue && field.href ? (
        <a
          href={field.href}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-flex items-center gap-1 break-all text-sm font-medium text-[#1c1c1d] hover:underline"
        >
          {field.value}
          <ExternalLink className="h-3 w-3 shrink-0" />
        </a>
      ) : (
        <p
          className={cn(
            "mt-1 break-words text-sm font-medium",
            hasValue ? "text-[#1c1c1d]" : "text-[rgba(28,28,29,0.4)]"
          )}
        >
          {hasValue ? field.value : "—"}
        </p>
      )}
      {field.hint ? <p className="mt-1 text-xs text-[rgba(28,28,29,0.5)]">{field.hint}</p> : null}
    </div>
  );
}
