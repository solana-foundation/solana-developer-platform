"use client";

import { useTranslations } from "@/i18n/provider";

/**
 * Stands in an empty state's action for a read-only member, so the state says
 * why there is nothing to start rather than ending in silence.
 */
export function ReadOnlyEmptyNote() {
  const t = useTranslations();
  return <p className="text-sm text-tertiary">{t("Shared.dashboardShell.readOnlyEmptyNote")}</p>;
}
