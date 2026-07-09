"use client";

import {
  AlignLeft,
  ArrowLeftRight,
  Building2,
  ClipboardList,
  DollarSign,
  ExternalLink,
  FileText,
  Globe,
  Hash,
  Image as ImageIcon,
  Info,
  KeyRound,
  Layers,
  type LucideIcon,
  Pencil,
  ShieldCheck,
  Tag,
  Type,
} from "lucide-react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { accessControlLabel, getCategorySections } from "../asset-details-config";
import { getAssetTypeLabel, getCategoryLabel } from "../asset-taxonomy";
import { safeLinkHref } from "../draft-mapping";
import type { DraftState, WizardStep } from "../issuance-draft-wizard.types";
import { useIssuanceDraft } from "../use-issuance-draft";

interface Field {
  icon: LucideIcon;
  label: string;
  value: string | null;
  hint?: string;
  href?: string | null;
  /** Optional image URL rendered as a small thumbnail beside the value (e.g. logo). */
  preview?: string | null;
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

  const categoryLabel = getCategoryLabel(draft.assetCategory);
  const typeLabel = getAssetTypeLabel(draft.assetCategory, draft.assetType);
  const transferRestrictionsEnabled =
    draft.accessControl === "allowlist" ||
    draft.accessControl === "blocklist" ||
    draft.capacities.transferApprovals;
  const website = draft.website.trim();
  const logo = draft.imageUrl.trim();
  // Issuer name is only collected for categories whose detail form includes it
  // (stablecoins & tokenized securities), so only surface it when it applies.
  const collectsIssuerName = getCategorySections(draft.assetCategory).some((section) =>
    section.fields.some((field) => field.key === "issuerName")
  );

  const sections: Section[] = [
    {
      icon: FileText,
      title: "Asset",
      description: "The asset and how it will be represented.",
      editStep: "classification",
      fields: [
        { icon: Layers, label: "Asset category", value: categoryLabel },
        { icon: Tag, label: "Asset type", value: typeLabel },
        { icon: Type, label: "Name", value: draft.name },
        { icon: DollarSign, label: "Symbol", value: draft.symbol },
      ],
    },
    {
      icon: Info,
      title: "Asset details",
      description: "Key information about the asset.",
      editStep: "asset-details",
      fields: [
        { icon: AlignLeft, label: "Description", value: draft.description },
        ...(collectsIssuerName
          ? [
              {
                icon: Building2,
                label: "Issuer name",
                value: draft.issuerName.trim() || null,
              },
            ]
          : []),
        { icon: Hash, label: "Decimals", value: draft.decimals },
        {
          icon: Globe,
          label: "Website",
          value: website || null,
          href: safeLinkHref(website) ?? null,
        },
      ],
    },
    {
      icon: ShieldCheck,
      title: "Compliance & access",
      description: "How the asset will be controlled and who can interact with it.",
      editStep: "asset-details",
      fields: [
        {
          icon: KeyRound,
          label: "Access control",
          value: accessControlLabel(draft.accessControl),
          hint: accessControlHint(draft.accessControl),
        },
        {
          icon: ArrowLeftRight,
          label: "Transfer restrictions",
          value: transferRestrictionsEnabled ? "Enabled" : "Disabled",
          hint: transferRestrictionsEnabled
            ? "Transfers limited to approved participants."
            : undefined,
        },
        {
          icon: ClipboardList,
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
        { icon: Type, label: "Public name", value: draft.name },
        { icon: DollarSign, label: "Public symbol", value: draft.symbol },
        {
          icon: ImageIcon,
          label: "Logo",
          value: logo || null,
          href: safeLinkHref(logo) ?? null,
          preview: logo || null,
        },
        { icon: AlignLeft, label: "Description (public)", value: draft.description },
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
    <div className="overflow-hidden rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white">
      <div className="flex items-start justify-between gap-4 border-b border-[rgba(28,28,29,0.07)] px-5 py-4">
        <div className="flex items-start gap-3.5">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[rgba(28,28,29,0.05)] text-[#1c1c1d]">
            <Icon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="text-base font-medium text-[#1c1c1d]">{section.title}</p>
            <p className="mt-0.5 text-sm text-[rgba(28,28,29,0.55)]">{section.description}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[rgba(28,28,29,0.12)] px-3 py-1.5 text-sm font-medium text-[rgba(28,28,29,0.75)] transition-colors hover:bg-[rgba(28,28,29,0.04)] hover:text-[#1c1c1d]"
        >
          <Pencil className="h-3.5 w-3.5" />
          Edit
        </button>
      </div>

      <dl className="divide-y divide-[rgba(28,28,29,0.06)] px-5 py-1">
        {section.fields.map((field) => (
          <FieldRow key={field.label} field={field} />
        ))}
      </dl>
    </div>
  );
}

function FieldRow({ field }: { field: Field }) {
  const Icon = field.icon;
  const hasValue = field.value !== null && field.value.trim().length > 0;
  const showPreview = hasValue && Boolean(field.preview?.trim());
  return (
    <div className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:gap-4">
      <dt className="flex shrink-0 items-center gap-2 text-sm text-[rgba(28,28,29,0.52)] sm:w-52 sm:pt-0.5">
        <Icon className="h-4 w-4 shrink-0 text-[rgba(28,28,29,0.38)]" />
        {field.label}
      </dt>
      <dd className="min-w-0 flex-1">
        {showPreview ? (
          // biome-ignore lint/performance/noImgElement: user-supplied external logo URL; next/image can't be configured for arbitrary hosts here.
          <img
            src={field.preview ?? undefined}
            alt=""
            className="h-10 w-10 shrink-0 rounded-lg bg-white object-cover ring-1 ring-black/5"
          />
        ) : hasValue && field.href ? (
          <a
            href={field.href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-w-0 items-center gap-1 break-all text-sm font-normal text-[#1c1c1d] hover:underline"
          >
            {field.value}
            <ExternalLink className="h-3 w-3 shrink-0" />
          </a>
        ) : (
          <p
            className={cn(
              "break-words text-sm font-normal",
              hasValue ? "text-[#1c1c1d]" : "text-[rgba(28,28,29,0.4)]"
            )}
          >
            {hasValue ? field.value : "—"}
          </p>
        )}
        {field.hint ? <p className="mt-1 text-xs text-[rgba(28,28,29,0.5)]">{field.hint}</p> : null}
      </dd>
    </div>
  );
}
