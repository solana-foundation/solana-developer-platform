"use client";

import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";

// Sticky footer bar shown while the edit form has unsaved changes.
export function AssetProfileSaveBar({
  dirty,
  saving,
  errorCount,
  onSave,
  onDiscard,
}: {
  dirty: boolean;
  saving: boolean;
  errorCount: number;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const t = useTranslations();
  if (!dirty) {
    return null;
  }

  return (
    <div className="sticky bottom-4 z-20">
      <div className="mx-auto flex max-w-xl items-center justify-between gap-4 rounded-2xl border border-border-default bg-surface-raised px-5 py-3">
        <p className="text-sm text-secondary">
          {errorCount > 0
            ? t("DashboardIssuance.saveBar.unsavedWithErrors", {
                count: errorCount,
                suffix: errorCount === 1 ? "" : "s",
              })
            : t("DashboardIssuance.saveBar.unsaved")}
        </p>
        <div className="flex items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onDiscard} disabled={saving}>
            {t("DashboardIssuance.saveBar.discard")}
          </Button>
          <Button type="button" size="sm" onClick={onSave} disabled={saving || errorCount > 0}>
            {saving ? (
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("DashboardIssuance.saveBar.saving")}
              </div>
            ) : (
              t("DashboardIssuance.saveBar.save")
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
