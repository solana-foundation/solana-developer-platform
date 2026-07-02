"use client";

import { CircleAlert, CircleCheck, Pencil, TriangleAlert } from "lucide-react";
import { motion } from "motion/react";
import { accessControlLabel, CAPACITY_META } from "../asset-details-config";
import { getAssetTypeLabel, getCategoryLabel } from "../asset-taxonomy";
import { getBlockers, getRequiredForDeployWarnings } from "../draft-mapping";
import { CAPACITY_KEYS } from "../issuance-draft-wizard.types";
import { useIssuanceDraft } from "../use-issuance-draft";

interface Row {
  label: string;
  value: string | null;
}

export function StepReview() {
  const { draft, goToStep } = useIssuanceDraft();
  const blockers = getBlockers(draft);
  const warnings = getRequiredForDeployWarnings(draft);

  const enabledCapacities = CAPACITY_KEYS.filter((key) => draft.capacities[key]).map(
    (key) => CAPACITY_META[key].label
  );

  const classificationRows: Row[] = [
    { label: "Category", value: getCategoryLabel(draft.assetCategory) },
    { label: "Asset type", value: getAssetTypeLabel(draft.assetCategory, draft.assetType) },
    { label: "Name", value: draft.name },
  ];
  const detailRows: Row[] = [
    { label: "Symbol", value: draft.symbol },
    { label: "Decimals", value: draft.decimals },
    { label: "Description", value: draft.description },
    { label: "Website", value: draft.website },
    { label: "Issuer", value: draft.issuerName },
    { label: "Peg / target", value: draft.pegTarget },
    { label: "Reserve custodian", value: draft.reserveCustodian },
    {
      label: "Documents",
      value: (() => {
        const count = draft.documents.filter((doc) => doc.name.trim() || doc.url.trim()).length;
        return count > 0 ? `${count} attached` : null;
      })(),
    },
  ];
  const complianceRows: Row[] = [
    { label: "Access control", value: accessControlLabel(draft.accessControl) },
    {
      label: "Capacities",
      value: enabledCapacities.length > 0 ? enabledCapacities.join(", ") : null,
    },
    {
      label: "Custom fields",
      value: (() => {
        const count = draft.customFields.filter((field) => field.key.trim()).length;
        return count > 0 ? `${count} added` : null;
      })(),
    },
  ];

  return (
    <motion.div
      key="review"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="space-y-6"
    >
      <div>
        <h2 className="text-2xl font-medium text-[#1c1c1d]">Review &amp; finish</h2>
        <p className="mt-1.5 text-sm text-[rgba(28,28,29,0.62)]">
          Confirm the details below, then create your draft.
        </p>
      </div>

      {blockers.length > 0 ? (
        <Callout
          tone="error"
          icon={<CircleAlert className="h-4 w-4" />}
          title="Resolve before creating"
        >
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {blockers.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </Callout>
      ) : (
        <Callout
          tone="success"
          icon={<CircleCheck className="h-4 w-4" />}
          title="You're ready to create a draft"
        >
          You can review, edit, and publish when you're ready.
        </Callout>
      )}

      {warnings.length > 0 ? (
        <Callout
          tone="warning"
          icon={<TriangleAlert className="h-4 w-4" />}
          title="Recommended before deploying"
        >
          These aren't required for a draft but are needed before you can deploy on-chain:{" "}
          {warnings.join(", ")}.
        </Callout>
      ) : null}

      <ReviewSection
        title="Classification"
        onEdit={() => goToStep("classification")}
        rows={classificationRows}
      />
      <ReviewSection
        title="Asset details"
        onEdit={() => goToStep("asset-details")}
        rows={detailRows}
      />
      <ReviewSection
        title="Compliance & access"
        onEdit={() => goToStep("asset-details")}
        rows={complianceRows}
      />
    </motion.div>
  );
}

function ReviewSection({
  title,
  onEdit,
  rows,
}: {
  title: string;
  onEdit: () => void;
  rows: Row[];
}) {
  return (
    <div className="rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white p-5">
      <div className="flex items-center justify-between">
        <p className="text-base font-medium text-[#1c1c1d]">{title}</p>
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm font-medium text-[rgba(28,28,29,0.7)] transition-colors hover:bg-[rgba(28,28,29,0.05)] hover:text-[#1c1c1d]"
        >
          <Pencil className="h-3.5 w-3.5" />
          Edit
        </button>
      </div>
      <div className="mt-3">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-start justify-between gap-3 border-b border-[rgba(28,28,29,0.06)] py-2.5 last:border-b-0"
          >
            <span className="text-sm text-[rgba(28,28,29,0.58)]">{row.label}</span>
            <span
              className={
                row.value?.trim()
                  ? "min-w-0 max-w-[60%] truncate text-right text-sm font-medium text-[#1c1c1d]"
                  : "text-right text-sm text-[rgba(28,28,29,0.4)]"
              }
            >
              {row.value?.trim() ? row.value : "—"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Callout({
  tone,
  icon,
  title,
  children,
}: {
  tone: "success" | "warning" | "error";
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  const toneClass =
    tone === "success"
      ? "border-[rgba(12,128,76,0.2)] bg-[rgba(12,128,76,0.06)] text-[#0c804c]"
      : tone === "warning"
        ? "border-[rgba(234,179,8,0.3)] bg-[rgba(234,179,8,0.08)] text-[#92400e]"
        : "border-[rgba(199,31,55,0.25)] bg-[rgba(199,31,55,0.06)] text-[#8a1f2a]";
  return (
    <div className={`flex items-start gap-2.5 rounded-2xl border px-4 py-3 ${toneClass}`}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 text-sm">
        <p className="font-semibold">{title}</p>
        <div className="mt-0.5 opacity-90">{children}</div>
      </div>
    </div>
  );
}
