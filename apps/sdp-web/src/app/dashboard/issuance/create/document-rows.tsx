"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslations } from "@/i18n/provider";
import type { DocumentRow } from "./issuance-draft-wizard.types";

interface DocumentRowsProps {
  documents: DocumentRow[];
  onChange: (documents: DocumentRow[]) => void;
  disabled?: boolean;
}

// Sentinel id for the always-present blank row shown when no documents exist
// yet. It carries no data until the user types — buildIssuanceMetadata ignores
// unfilled rows — so it reads as a fillable form rather than an empty state.
const EMPTY_ROW_ID = "__empty__";

function emptyRow(id: string): DocumentRow {
  return { id, docType: "", name: "", url: "" };
}

export function DocumentRows({ documents, onChange, disabled }: DocumentRowsProps) {
  const t = useTranslations();
  // Always render at least one row. When there are no real documents we show a
  // blank placeholder; the first edit promotes it into a stored row.
  const rows = documents.length > 0 ? documents : [emptyRow(EMPTY_ROW_ID)];

  const update = (id: string, patch: Partial<DocumentRow>) => {
    if (id === EMPTY_ROW_ID) {
      onChange([{ ...emptyRow(crypto.randomUUID()), ...patch }]);
      return;
    }
    onChange(documents.map((doc) => (doc.id === id ? { ...doc, ...patch } : doc)));
  };

  const remove = (id: string) => {
    // Clearing the only document empties the form instead of removing it, so a
    // blank row always remains for the user to fill.
    if (documents.length <= 1) {
      onChange([]);
      return;
    }
    onChange(documents.filter((doc) => doc.id !== id));
  };

  return (
    <div className="space-y-3">
      {rows.map((doc) => (
        <div key={doc.id} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_1.4fr_auto]">
          <Input
            placeholder={t("DashboardIssuance.assetDetails.documentTypePlaceholder")}
            disabled={disabled}
            value={doc.docType}
            onChange={(event) => update(doc.id, { docType: event.currentTarget.value })}
          />
          <Input
            placeholder={t("DashboardIssuance.assetDetails.documentNamePlaceholder")}
            disabled={disabled}
            value={doc.name}
            onChange={(event) => update(doc.id, { name: event.currentTarget.value })}
          />
          <Input
            placeholder={t("DashboardIssuance.assetDetails.websitePlaceholder")}
            disabled={disabled}
            value={doc.url}
            onChange={(event) => update(doc.id, { url: event.currentTarget.value })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            onClick={() => remove(doc.id)}
            aria-label={t("DashboardIssuance.assetDetails.removeDocument")}
            className="self-center text-error hover:bg-error-bg hover:text-error"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={disabled}
        onClick={() => onChange([...documents, emptyRow(crypto.randomUUID())])}
        iconLeft={<Plus className="h-4 w-4" />}
      >
        {t("DashboardIssuance.assetDetails.addDocument")}
      </Button>
    </div>
  );
}
