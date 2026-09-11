"use client";

import { Loader2 } from "lucide-react";
import { AnimatePresence, domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";

function UnsavedChangesMessage({ dirty, errorCount }: { dirty: boolean; errorCount: number }) {
  const t = useTranslations();
  if (!dirty) return null;
  if (errorCount === 0) return t("DashboardIssuance.saveBar.unsaved");
  return t("DashboardIssuance.saveBar.unsavedWithErrors", {
    count: errorCount,
    suffix: errorCount === 1 ? "" : "s",
  });
}

// Settings editing and unsaved permission changes share the same footer.
export function AssetProfileSaveBar({
  editing,
  dirty,
  saving,
  errorCount,
  onSave,
  onDiscard,
  children,
}: {
  editing: boolean;
  dirty: boolean;
  saving: boolean;
  errorCount: number;
  onSave: () => void;
  onDiscard: () => void;
  children?: ReactNode;
}) {
  const t = useTranslations();
  const reducedMotion = useReducedMotion();

  return (
    <LazyMotion features={domAnimation}>
      <AnimatePresence initial={false}>
        {editing || dirty ? (
          <m.div
            key="save-bar"
            initial={{ opacity: 0, y: reducedMotion ? 0 : 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reducedMotion ? 0 : 8 }}
            transition={{ duration: reducedMotion ? 0 : 0.16 }}
            className="sticky bottom-4 z-20"
          >
            <div className="mx-auto max-w-xl space-y-3 rounded-2xl border border-border-default bg-surface-raised px-5 py-3">
              {children}
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm text-secondary">
                  <UnsavedChangesMessage dirty={dirty} errorCount={errorCount} />
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={onDiscard}
                    disabled={saving}
                  >
                    {t("DashboardIssuance.saveBar.discard")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={onSave}
                    disabled={!dirty || saving || errorCount > 0}
                  >
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
          </m.div>
        ) : null}
      </AnimatePresence>
    </LazyMotion>
  );
}
