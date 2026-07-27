"use client";

import { useTranslations } from "@/i18n/provider";

export interface WizardSummaryDetail {
  label: string;
  value: string;
}

/**
 * Renders the selections a user has made so far in a payments wizard.
 *
 * @param props - The labeled selection values, in step order.
 * @returns The wizard summary list.
 */
export function WizardSummaryList({ details }: { details: WizardSummaryDetail[] }) {
  const t = useTranslations();
  return (
    <div>
      <p className="text-base font-medium text-primary">
        {t("DashboardPayments.wizardSummaryTitle")}
      </p>
      <div className="mt-3">
        {details.map((detail) => (
          <div
            key={detail.label}
            className="flex items-start gap-3 border-b border-border-subtle py-2.5 last:border-b-0"
          >
            <span className="shrink-0 text-sm text-tertiary">{detail.label}</span>
            <span className="ml-auto min-w-0 break-words text-right text-sm font-medium text-primary">
              {detail.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
