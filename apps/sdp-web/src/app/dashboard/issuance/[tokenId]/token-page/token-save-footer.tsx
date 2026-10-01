"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";

/**
 * The bar under an edited tab: what saving does on the left, Discard and Save changes on the
 * right, held to the bottom of the page while the edit is open.
 */
export function TokenSaveFooter({
  note,
  saving,
  saveDisabled,
  errorCount,
  signer,
  onDiscard,
  onSave,
}: {
  note: string;
  saving: boolean;
  saveDisabled: boolean;
  errorCount: number;
  /** The wallet that signs an on-chain metadata change, where one has to be picked. */
  signer?: ReactNode;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const t = useTranslations();
  return (
    <div
      data-token-save-footer
      className="sticky bottom-0 z-20 mt-12 flex flex-col gap-3 border-t border-border-subtle bg-surface py-4"
    >
      {signer ? <div className="max-w-md">{signer}</div> : null}
      <div className="flex flex-wrap items-center gap-4">
        <p className="min-w-0 flex-1 text-meta text-secondary">
          {errorCount > 0
            ? t("DashboardIssuance.newDesign.details.fixErrors", { count: errorCount })
            : note}
        </p>
        <Button variant="secondary" disabled={saving} onClick={onDiscard}>
          {t("DashboardIssuance.newDesign.details.discard")}
        </Button>
        <Button disabled={saving || saveDisabled} onClick={onSave}>
          {saving
            ? t("DashboardIssuance.newDesign.details.saving")
            : t("DashboardIssuance.newDesign.details.saveChanges")}
        </Button>
      </div>
    </div>
  );
}
