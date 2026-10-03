"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";

/**
 * The bar under an edited tab: what saving does on the left, Discard and Save changes on the
 * right. As the design draws it, a band across the bottom of the work area on the sidebar's
 * paper (like a wizard's footer), its content in the page's column, while the edit is open.
 * The shell's section is a size container, so `fixed` holds the band to that section, not the
 * window; a spacer in the page's flow keeps the last fields clear of it.
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
    <>
      <div aria-hidden="true" className={signer ? "h-32" : "h-16"} />
      <div
        data-token-save-footer
        className="fixed inset-x-0 bottom-0 z-20 border-t border-border-subtle bg-surface px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:px-6"
      >
        <div className="mx-auto flex w-full max-w-page flex-col gap-3">
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
    </>
  );
}
