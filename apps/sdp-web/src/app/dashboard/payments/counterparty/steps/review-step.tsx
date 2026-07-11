"use client";

import { ReviewRow } from "../components/review-row";
import { SectionDivider } from "../components/section-divider";
import { useTranslations } from "@/i18n/provider";
import { useCounterpartyCreate } from "../counterparty-create-context";
import { addressSchema, basicsSchema, identitySchema } from "../counterparty-create-schemas";

export function ReviewStep() {
  const t = useTranslations();
  const { basics, identity, address, steps, submitError } = useCounterpartyCreate();

  const basicsParsed = basicsSchema.safeParse(basics.values);
  const identityParsed = identitySchema.safeParse(identity.values);
  const addressParsed = addressSchema.safeParse(address.values);

  if (!basicsParsed.success || !identityParsed.success || !addressParsed.success) {
    return null;
  }

  const basicsValues = basicsParsed.data;
  const identityValues = identityParsed.data;
  const addressValues = addressParsed.data;

  const hasIdentityStep = steps.includes("identity");
  const hasAnyIdentity = !!(
    identityValues.firstName ||
    identityValues.lastName ||
    identityValues.dateOfBirth ||
    identityValues.phone
  );

  return (
    <div className="space-y-6">
      <SectionDivider label={t("DashboardPayments.counterparty.basics")} />
      <div className="space-y-1">
        <ReviewRow
          label={t("DashboardPayments.counterparty.entityType")}
          value={t(`DashboardPayments.counterparty.${basicsValues.entityType}`)}
        />
        <ReviewRow label={t("DashboardPayments.counterparty.displayName")} value={basicsValues.displayName} />
        <ReviewRow label={t("DashboardPayments.counterparty.email")} value={basicsValues.email} />
        {basicsValues.externalId ? (
          <ReviewRow label={t("DashboardPayments.counterparty.externalId")} value={basicsValues.externalId} />
        ) : null}
      </div>

      {hasIdentityStep && hasAnyIdentity ? (
        <>
          <SectionDivider label={t("DashboardPayments.counterparty.personalInfo")} />
          <div className="space-y-1">
            {identityValues.firstName ? (
              <ReviewRow label={t("DashboardPayments.counterparty.firstName")} value={identityValues.firstName} />
            ) : null}
            {identityValues.lastName ? (
              <ReviewRow label={t("DashboardPayments.counterparty.lastName")} value={identityValues.lastName} />
            ) : null}
            {identityValues.dateOfBirth ? (
              <ReviewRow label={t("DashboardPayments.counterparty.dateOfBirth")} value={identityValues.dateOfBirth} />
            ) : null}
            {identityValues.phone ? <ReviewRow label={t("DashboardPayments.counterparty.phone")} value={identityValues.phone} /> : null}
          </div>
        </>
      ) : null}

      <SectionDivider label={t("DashboardPayments.counterparty.address")} />
      <div className="space-y-1">
        <ReviewRow label={t("DashboardPayments.counterparty.line1")} value={addressValues.line1} />
        {addressValues.line2 ? <ReviewRow label={t("DashboardPayments.counterparty.line2")} value={addressValues.line2} /> : null}
        <ReviewRow label={t("DashboardPayments.counterparty.city")} value={addressValues.city} />
        {addressValues.postalCode ? (
          <ReviewRow label={t("DashboardPayments.counterparty.postalCode")} value={addressValues.postalCode} />
        ) : null}
        <ReviewRow label={t("DashboardPayments.counterparty.country")} value={addressValues.countryCode} />
        {addressValues.subdivisionCode ? (
          <ReviewRow label={t("DashboardPayments.counterparty.stateProvince")} value={addressValues.subdivisionCode} />
        ) : null}
      </div>

      {submitError ? <p className="text-sm text-status-error-text">{submitError}</p> : null}
    </div>
  );
}
