"use client";

import { useTranslations } from "@/i18n/provider";
import { ReviewRow } from "../components/review-row";
import { SectionDivider } from "../components/section-divider";
import { useCounterpartyCreate } from "../counterparty-create-context";
import { addressSchema, basicsSchema, identitySchema } from "../counterparty-create-schemas";

export function ReviewStep() {
  const t = useTranslations();
  const { basics, identity, address, steps, submitError } = useCounterpartyCreate();

  const hasIdentityStep = steps.includes("identity");
  const basicsParsed = basicsSchema.safeParse(basics.values);
  const identityParsed = hasIdentityStep ? identitySchema.safeParse(identity.values) : null;
  const addressParsed = addressSchema.safeParse(address.values);

  if (
    !basicsParsed.success ||
    !addressParsed.success ||
    (identityParsed !== null && !identityParsed.success)
  ) {
    return null;
  }

  const basicsValues = basicsParsed.data;
  const addressValues = addressParsed.data;

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

      {identityParsed?.success ? (
        <>
          <SectionDivider label={t("DashboardPayments.counterparty.personalInfo")} />
          <div className="space-y-1">
            <ReviewRow
              label={t("DashboardPayments.counterparty.firstName")}
              value={identityParsed.data.firstName}
            />
            <ReviewRow
              label={t("DashboardPayments.counterparty.lastName")}
              value={identityParsed.data.lastName}
            />
            <ReviewRow
              label={t("DashboardPayments.counterparty.dateOfBirth")}
              value={identityParsed.data.dateOfBirth}
            />
            <ReviewRow
              label={t("DashboardPayments.counterparty.phone")}
              value={identityParsed.data.phone}
            />
          </div>
        </>
      ) : null}

      <SectionDivider label={t("DashboardPayments.counterparty.address")} />
      <div className="space-y-1">
        <ReviewRow label={t("DashboardPayments.counterparty.line1")} value={addressValues.line1} />
        {addressValues.line2 ? (
          <ReviewRow
            label={t("DashboardPayments.counterparty.line2")}
            value={addressValues.line2}
          />
        ) : null}
        <ReviewRow label={t("DashboardPayments.counterparty.city")} value={addressValues.city} />
        {addressValues.postalCode ? (
          <ReviewRow
            label={t("DashboardPayments.counterparty.postalCode")}
            value={addressValues.postalCode}
          />
        ) : null}
        <ReviewRow
          label={t("DashboardPayments.counterparty.country")}
          value={addressValues.countryCode}
        />
        {addressValues.subdivisionCode ? (
          <ReviewRow
            label={t("DashboardPayments.counterparty.stateProvince")}
            value={addressValues.subdivisionCode}
          />
        ) : null}
      </div>

      {submitError ? <p className="text-sm text-error">{submitError}</p> : null}
    </div>
  );
}
