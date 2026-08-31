"use client";

import { Loader2Icon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { CardFooter } from "@/components/ui/card";
import { useTranslations } from "@/i18n/provider";

export function EarnButtonBuilderFooter({
  earnHref,
  hasUnsavedChanges,
  isSaving,
  onSave,
  previewOnly = false,
  saveError,
}: {
  earnHref: string;
  hasUnsavedChanges: boolean;
  isSaving: boolean;
  onSave: () => void;
  previewOnly?: boolean;
  saveError: string | null;
}) {
  const t = useTranslations();
  return (
    <CardFooter className="flex-wrap gap-3 border-t border-border-default">
      {previewOnly ? (
        <Callout className="min-w-0 flex-1 text-xs leading-5" variant="warning">
          {t("DashboardMarkets.earnProgram.mainnetPreviewFooter")}
        </Callout>
      ) : (
        <div className="min-w-0 flex-1">
          {saveError ? (
            <p className="text-xs text-error" role="alert">
              {t("DashboardMarkets.earnProgram.saveError", { error: saveError })}
            </p>
          ) : !hasUnsavedChanges ? (
            <p className="text-xs text-secondary">
              {t("DashboardMarkets.earnProgram.savedConfiguration")}
            </p>
          ) : null}
        </div>
      )}
      <Button asChild variant="secondary">
        <Link href={earnHref}>{t("DashboardMarkets.earnProgram.done")}</Link>
      </Button>
      <Button
        disabled={previewOnly || !hasUnsavedChanges || isSaving}
        iconLeft={isSaving ? <Loader2Icon className="animate-spin" /> : undefined}
        onClick={onSave}
      >
        {t(
          isSaving
            ? "DashboardMarkets.earnProgram.savingConfiguration"
            : "DashboardMarkets.earnProgram.saveConfiguration"
        )}
      </Button>
    </CardFooter>
  );
}
