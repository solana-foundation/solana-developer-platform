"use client";

import { useTranslations } from "@/i18n/provider";
import { ReviewRow } from "../components/review-row";
import { SectionDivider } from "../components/section-divider";
import { useCounterpartyCreate } from "../counterparty-create-context";
import { basicsSchema, type IdentityClean, identitySchema } from "../counterparty-create-schemas";

export function ReviewStep() {
  const t = useTranslations();
  const { basics, identity, steps, submitError } = useCounterpartyCreate();

  const hasIdentityStep = steps.includes("identity");
  const basicsParsed = basicsSchema.safeParse(basics.values);
  if (!basicsParsed.success) {
    return null;
  }
  let identityValues: IdentityClean | null = null;
  if (hasIdentityStep) {
    const identityParsed = identitySchema.safeParse(identity.values);
    if (!identityParsed.success) {
      return null;
    }
    identityValues = identityParsed.data;
  }

  const basicsValues = basicsParsed.data;

  return (
    <div className="space-y-6">
      <SectionDivider label={t("DashboardPayments.counterparty.basics")} />
      <div className="space-y-1">
        <ReviewRow
          label={t("DashboardPayments.counterparty.entityType")}
          value={t(`DashboardPayments.counterparty.${basicsValues.entityType}`)}
        />
        <ReviewRow
          label={t("DashboardPayments.counterparty.displayName")}
          value={basicsValues.displayName}
        />
        <ReviewRow label={t("DashboardPayments.counterparty.email")} value={basicsValues.email} />
        {basicsValues.externalId ? (
          <ReviewRow
            label={t("DashboardPayments.counterparty.externalId")}
            value={basicsValues.externalId}
          />
        ) : null}
      </div>

      {identityValues !== null ? (
        <>
          <SectionDivider label={t("DashboardPayments.counterparty.personalInfo")} />
          <div className="space-y-1">
            <ReviewRow
              label={t("DashboardPayments.counterparty.firstName")}
              value={identityValues.firstName}
            />
            <ReviewRow
              label={t("DashboardPayments.counterparty.lastName")}
              value={identityValues.lastName}
            />
            <ReviewRow
              label={t("DashboardPayments.counterparty.dateOfBirth")}
              value={identityValues.dateOfBirth}
            />
          </div>
        </>
      ) : null}

      {submitError ? <p className="text-sm text-error">{submitError}</p> : null}
    </div>
  );
}
