"use client";

import { humanizeEnumLabel } from "@/lib/utils";
import { ReviewRow } from "../components/review-row";
import { SectionDivider } from "../components/section-divider";
import { useCounterpartyCreate } from "../counterparty-create-context";
import {
  addressSchema,
  basicsSchema,
  complianceSchema,
  identitySchema,
} from "../counterparty-create-schemas";

export function ReviewStep() {
  const { basics, identity, address, compliance, steps, submitError } = useCounterpartyCreate();

  const basicsParsed = basicsSchema.safeParse(basics.values);
  const identityParsed = identitySchema.safeParse(identity.values);
  const addressParsed = addressSchema.safeParse(address.values);

  if (!basicsParsed.success || !identityParsed.success || !addressParsed.success) {
    return null;
  }

  const basicsValues = basicsParsed.data;
  const identityValues = identityParsed.data;
  const addressValues = addressParsed.data;

  const hasComplianceStep = steps.includes("compliance");
  const complianceParsed = complianceSchema.safeParse(compliance.values);
  const complianceValues =
    hasComplianceStep && complianceParsed.success ? complianceParsed.data : null;

  const hasIdentityStep = steps.includes("identity");
  const hasAnyIdentity = !!(
    identityValues.firstName ||
    identityValues.lastName ||
    identityValues.dateOfBirth ||
    identityValues.phone
  );

  return (
    <div className="space-y-6">
      <SectionDivider label="Basics" />
      <div className="space-y-1">
        <ReviewRow
          label="Entity type"
          value={basicsValues.entityType === "individual" ? "Individual" : "Business"}
        />
        <ReviewRow label="Display name" value={basicsValues.displayName} />
        <ReviewRow label="Email" value={basicsValues.email} />
        {basicsValues.externalId ? (
          <ReviewRow label="External ID" value={basicsValues.externalId} />
        ) : null}
      </div>

      {hasIdentityStep && hasAnyIdentity ? (
        <>
          <SectionDivider label="Personal info" />
          <div className="space-y-1">
            {identityValues.firstName ? (
              <ReviewRow label="First name" value={identityValues.firstName} />
            ) : null}
            {identityValues.lastName ? (
              <ReviewRow label="Last name" value={identityValues.lastName} />
            ) : null}
            {identityValues.dateOfBirth ? (
              <ReviewRow label="Date of birth" value={identityValues.dateOfBirth} />
            ) : null}
            {identityValues.phone ? <ReviewRow label="Phone" value={identityValues.phone} /> : null}
          </div>
        </>
      ) : null}

      <SectionDivider label="Address" />
      <div className="space-y-1">
        <ReviewRow label="Line 1" value={addressValues.line1} />
        {addressValues.line2 ? <ReviewRow label="Line 2" value={addressValues.line2} /> : null}
        <ReviewRow label="City" value={addressValues.city} />
        {addressValues.postalCode ? (
          <ReviewRow label="Postal code" value={addressValues.postalCode} />
        ) : null}
        <ReviewRow label="Country" value={addressValues.countryCode} />
        {addressValues.subdivisionCode ? (
          <ReviewRow label="State / Province" value={addressValues.subdivisionCode} />
        ) : null}
      </div>

      {complianceValues ? (
        <>
          <SectionDivider label="Tax & compliance" />
          <div className="space-y-1">
            <ReviewRow label="Tax ID" value={complianceValues.taxIdNumber} />
            <ReviewRow label="Nationality" value={complianceValues.nationality} />
            <ReviewRow label="Country of birth" value={complianceValues.birthCountryCode} />
            <ReviewRow
              label="Employment status"
              value={humanizeEnumLabel(complianceValues.employmentStatus)}
            />
            <ReviewRow
              label="Source of funds"
              value={humanizeEnumLabel(complianceValues.sourceOfFunds)}
            />
            <ReviewRow label="PEP status" value={humanizeEnumLabel(complianceValues.pepStatus)} />
            <ReviewRow
              label="Intended use"
              value={humanizeEnumLabel(complianceValues.intendedUseOfAccount)}
            />
            <ReviewRow
              label="Yearly income"
              value={humanizeEnumLabel(complianceValues.estimatedYearlyIncome)}
            />
            <ReviewRow
              label="Industry sector"
              value={humanizeEnumLabel(complianceValues.employmentIndustrySector)}
            />
            <ReviewRow
              label="Monthly volume (USD)"
              value={complianceValues.expectedMonthlyVolume}
            />
          </div>
        </>
      ) : null}

      {submitError ? <p className="text-sm text-status-error-text">{submitError}</p> : null}
    </div>
  );
}
