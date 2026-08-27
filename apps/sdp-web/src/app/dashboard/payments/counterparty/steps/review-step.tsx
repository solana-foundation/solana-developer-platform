"use client";

import { useTranslations } from "@/i18n/provider";
import { ReviewRow } from "../components/review-row";
import { useCounterpartyCreate } from "../counterparty-create-context";
import { basicsSchema } from "../counterparty-create-schemas";

export function ReviewStep() {
  const t = useTranslations();
  const { basics, submitError } = useCounterpartyCreate();

  const basicsParsed = basicsSchema.safeParse(basics.values);

  if (!basicsParsed.success) {
    return null;
  }

  const basicsValues = basicsParsed.data;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <ReviewRow
          label={t("DashboardPayments.counterparty.entityType")}
          value={t(`DashboardPayments.counterparty.${basicsValues.entityType}`)}
        />
        <ReviewRow
          label={t("DashboardPayments.counterparty.displayName")}
          value={basicsValues.displayName}
        />
        {basicsValues.externalId ? (
          <ReviewRow
            label={t("DashboardPayments.counterparty.externalId")}
            value={basicsValues.externalId}
          />
        ) : null}
      </div>

      {submitError ? <p className="text-sm text-error">{submitError}</p> : null}
    </div>
  );
}
