"use client";

import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

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
  if (!dirty) {
    return null;
  }

  return (
    <div className="sticky bottom-4 z-20">
      <div className="mx-auto flex max-w-xl items-center justify-between gap-4 rounded-2xl border border-[rgba(28,28,29,0.14)] bg-white px-5 py-3">
        <p className="text-sm text-[rgba(28,28,29,0.72)]">
          {errorCount > 0
            ? `Unsaved changes — ${errorCount} field${errorCount === 1 ? "" : "s"} need attention`
            : "You have unsaved changes"}
        </p>
        <div className="flex items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onDiscard} disabled={saving}>
            Discard
          </Button>
          <Button type="button" size="sm" onClick={onSave} disabled={saving || errorCount > 0}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : (
              "Save changes"
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
