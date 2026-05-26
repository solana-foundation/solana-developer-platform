"use client";

import { ArrowLeftIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ReviewRow } from "../components/review-row";
import { SectionDivider } from "../components/section-divider";
import { useCounterpartyCreate } from "../counterparty-create-context";
import { addressSchema, basicsSchema, identitySchema } from "../counterparty-create-schemas";

export function ReviewStep() {
  const { basics, identity, address, steps, submit, submitting, submitError, goBack } =
    useCounterpartyCreate();

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

      {submitError ? <p className="text-sm text-status-error-text">{submitError}</p> : null}

      <div className="flex items-center justify-between pt-2">
        <Button
          type="button"
          variant="outline"
          onClick={goBack}
          disabled={submitting}
          iconLeft={<ArrowLeftIcon />}
        >
          Back
        </Button>
        <Button
          type="button"
          onClick={submit}
          disabled={submitting}
          iconLeft={submitting ? <Loader2Icon className="animate-spin" /> : undefined}
        >
          {submitting ? "Creating" : "Create"}
        </Button>
      </div>
    </div>
  );
}
