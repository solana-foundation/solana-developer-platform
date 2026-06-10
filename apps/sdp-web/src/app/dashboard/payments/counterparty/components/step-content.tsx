"use client";

import type { StepId } from "../counterparty-create-schemas";
import { AddressStep } from "../steps/address-step";
import { BasicsStep } from "../steps/basics-step";
import { IdentityStep } from "../steps/identity-step";
import { ReviewStep } from "../steps/review-step";

export function StepContent({ stepId }: { stepId: StepId }) {
  switch (stepId) {
    case "basics":
      return <BasicsStep />;
    case "identity":
      return <IdentityStep />;
    case "address":
      return <AddressStep />;
    case "review":
      return <ReviewStep />;
  }
}
