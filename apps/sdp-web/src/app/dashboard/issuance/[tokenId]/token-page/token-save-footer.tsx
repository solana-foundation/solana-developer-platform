"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";

/**
 * The bar under an edited tab: what saving does on the left, Discard and Save changes on the
 * right. As the design draws it, a band across the work area on the sidebar's paper (like a
 * wizard's footer), held to the bottom while the edit is open, its content in the page's
 * column. The band bleeds out of the column by the scroll panel's side padding: the work area
 * (`100cqw`) less the column, which is the page width inside the shell's 16px gutter (24px
 * from md). The token page drops the panel's bottom padding while the band is open, so it
 * sits on the bottom edge.
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
      className={cn(
        "sticky bottom-0 z-20 mt-12 border-t border-border-subtle bg-surface pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))]",
        "-mx-[calc((100cqw-min(100cqw-2rem,var(--container-page)))/2)] px-[calc((100cqw-min(100cqw-2rem,var(--container-page)))/2)]",
        "md:-mx-[calc((100cqw-min(100cqw-3rem,var(--container-page)))/2)] md:px-[calc((100cqw-min(100cqw-3rem,var(--container-page)))/2)]"
      )}
    >
      <div className="flex flex-col gap-3">
        {signer ? <div className="max-w-md">{signer}</div> : null}
        <div className="flex flex-wrap items-center gap-4">
          <p className="min-w-0 flex-1 text-meta text-secondary">
            {errorCount > 0
              ? t("DashboardIssuance.newDesign.details.fixErrors", { count: errorCount })
              : note}
          </p>
          <Button variant="outline" disabled={saving} onClick={onDiscard}>
            {t("DashboardIssuance.newDesign.details.discard")}
          </Button>
          <Button disabled={saving || saveDisabled} onClick={onSave}>
            {saving
              ? t("DashboardIssuance.newDesign.details.saving")
              : t("DashboardIssuance.newDesign.details.saveChanges")}
          </Button>
        </div>
      </div>
    </div>
  );
}
