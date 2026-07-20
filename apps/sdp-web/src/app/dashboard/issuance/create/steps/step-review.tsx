"use client";

import {
  AlignLeft,
  Anchor,
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
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { detailSectionsHaveField, getPegSummary } from "../asset-details-config";
import { getAssetTypeLabel, getCategoryLabelKey } from "../asset-taxonomy";
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

type Translate = ReturnType<typeof useTranslations>;

function accessControlHint(mode: DraftState["accessControl"], t: Translate): string | undefined {
  switch (mode) {
    case "allowlist":
      return t("DashboardIssuance.review.allowlistHint");
    case "blocklist":
      return t("DashboardIssuance.review.blocklistHint");
    default:
      return undefined;
  }
}

function accessControlReviewLabel(mode: DraftState["accessControl"], t: Translate): string | null {
  switch (mode) {
    case "allowlist":
      return t("DashboardIssuance.review.allowlist");
    case "blocklist":
      return t("DashboardIssuance.review.blocklist");
    case "disabled":
      return t("DashboardIssuance.review.none");
    default:
      return null;
  }
}

export function StepReview() {
  const t = useTranslations();
  const { draft, goToStep } = useIssuanceDraft();

  const categoryLabelKey = getCategoryLabelKey(draft.assetCategory);
  const categoryLabel = categoryLabelKey ? t(categoryLabelKey) : null;
  const typeLabel = getAssetTypeLabel(draft.assetCategory, draft.assetType, t);
  const transferRestrictionsEnabled =
    draft.accessControl === "allowlist" ||
    draft.accessControl === "blocklist" ||
    draft.capacities.transferApprovals;
  const website = draft.website.trim();
  const logo = draft.imageUrl.trim();
  // Issuer name is only collected for categories whose detail form includes it
  // (stablecoins & tokenized securities), so only surface it when it applies.
  const collectsIssuerName = detailSectionsHaveField(
    draft.assetCategory,
    draft.assetType,
    "issuerName"
  );
  const pegSummary = getPegSummary(draft);

  const sections: Section[] = [
    {
      icon: FileText,
      title: t("DashboardIssuance.review.assetTitle"),
      description: t("DashboardIssuance.review.assetDescription"),
      editStep: "classification",
      fields: [
        { icon: Layers, label: t("DashboardIssuance.review.assetCategory"), value: categoryLabel },
        { icon: Tag, label: t("DashboardIssuance.review.assetType"), value: typeLabel },
        { icon: Type, label: t("DashboardIssuance.review.name"), value: draft.name },
        { icon: DollarSign, label: t("DashboardIssuance.review.symbol"), value: draft.symbol },
      ],
    },
    {
      icon: Info,
      title: t("DashboardIssuance.review.assetDetailsTitle"),
      description: t("DashboardIssuance.review.assetDetailsDescription"),
      editStep: "asset-details",
      fields: [
        {
          icon: AlignLeft,
          label: t("DashboardIssuance.review.description"),
          value: draft.description,
        },
        ...(collectsIssuerName
          ? [
              {
                icon: Building2,
                label: t("DashboardIssuance.review.issuerName"),
                value: draft.issuerName.trim() || null,
              },
            ]
          : []),
        ...(pegSummary
          ? [
              {
                icon: Anchor,
                label: t("DashboardIssuance.summary.peggedTo"),
                value: pegSummary,
              },
            ]
          : []),
        { icon: Hash, label: t("DashboardIssuance.review.decimals"), value: draft.decimals },
        {
          icon: Globe,
          label: t("DashboardIssuance.review.website"),
          value: website || null,
          href: safeLinkHref(website) ?? null,
        },
      ],
    },
    {
      icon: ShieldCheck,
      title: t("DashboardIssuance.review.complianceAccessTitle"),
      description: t("DashboardIssuance.review.complianceAccessDescription"),
      editStep: "asset-details",
      fields: [
        {
          icon: KeyRound,
          label: t("DashboardIssuance.review.accessControl"),
          value: accessControlReviewLabel(draft.accessControl, t),
          hint: accessControlHint(draft.accessControl, t),
        },
        {
          icon: ArrowLeftRight,
          label: t("DashboardIssuance.review.transferRestrictions"),
          value: transferRestrictionsEnabled
            ? t("DashboardIssuance.review.enabled")
            : t("DashboardIssuance.review.disabled"),
          hint: transferRestrictionsEnabled
            ? t("DashboardIssuance.review.transferRestrictionsHint")
            : undefined,
        },
        {
          icon: ClipboardList,
          label: t("DashboardIssuance.review.investorReporting"),
          value: draft.capacities.investorReporting
            ? t("DashboardIssuance.review.enabled")
            : t("DashboardIssuance.review.disabled"),
          hint: draft.capacities.investorReporting
            ? t("DashboardIssuance.review.investorReportingHint")
            : undefined,
        },
      ],
    },
    {
      icon: Globe,
      title: t("DashboardIssuance.review.publicInformationTitle"),
      description: t("DashboardIssuance.review.publicInformationDescription"),
      editStep: "public-info",
      fields: [
        { icon: Type, label: t("DashboardIssuance.review.publicName"), value: draft.name },
        {
          icon: DollarSign,
          label: t("DashboardIssuance.review.publicSymbol"),
          value: draft.symbol,
        },
        {
          icon: ImageIcon,
          label: t("DashboardIssuance.review.logo"),
          value: logo || null,
          href: safeLinkHref(logo) ?? null,
          preview: logo || null,
        },
        {
          icon: AlignLeft,
          label: t("DashboardIssuance.review.publicDescription"),
          value: draft.description,
        },
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
  const t = useTranslations();
  const Icon = section.icon;
  return (
    <div className="overflow-hidden rounded-2xl border border-border-default bg-white">
      <div className="flex items-start justify-between gap-4 border-b border-border-subtle px-5 py-4">
        <div className="flex items-start gap-3.5">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-fill-subtle text-primary">
            <Icon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="text-base font-medium text-primary">{section.title}</p>
            <p className="mt-0.5 text-sm text-tertiary">{section.description}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border-default px-3 py-1.5 text-sm font-medium text-secondary transition-colors hover:bg-fill-subtle hover:text-primary"
        >
          <Pencil className="h-3.5 w-3.5" />
          {t("DashboardIssuance.review.edit")}
        </button>
      </div>

      <dl className="divide-y divide-border-subtle px-5 py-1">
        {section.fields.map((field) => (
          <FieldRow key={field.label} field={field} />
        ))}
      </dl>
    </div>
  );
}

function FieldRow({ field }: { field: Field }) {
  const t = useTranslations();
  const Icon = field.icon;
  const hasValue = field.value !== null && field.value.trim().length > 0;
  const showPreview = hasValue && Boolean(field.preview?.trim());
  return (
    <div className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:gap-4">
      <dt className="flex shrink-0 items-center gap-2 text-sm text-tertiary sm:w-52 sm:pt-0.5">
        <Icon className="h-4 w-4 shrink-0 text-muted" />
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
            className="inline-flex min-w-0 items-center gap-1 break-all text-sm font-normal text-primary hover:underline"
          >
            {field.value}
            <ExternalLink className="h-3 w-3 shrink-0" />
          </a>
        ) : (
          <p
            className={cn(
              "break-words text-sm font-normal",
              hasValue ? "text-primary" : "text-muted"
            )}
          >
            {hasValue ? field.value : t("DashboardIssuance.review.notProvided")}
          </p>
        )}
        {field.hint ? <p className="mt-1 text-xs text-tertiary">{field.hint}</p> : null}
      </dd>
    </div>
  );
}
