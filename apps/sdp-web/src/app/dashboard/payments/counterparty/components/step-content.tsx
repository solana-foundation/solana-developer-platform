"use client";

import type { StepId } from "../counterparty-create-schemas";
import { BasicsStep } from "../steps/basics-step";
import { IdentityStep } from "../steps/identity-step";
import { ReviewStep } from "../steps/review-step";

export function StepContent({ stepId }: { stepId: StepId }) {
  switch (stepId) {
    case "basics":
      return <BasicsStep />;
    case "identity":
      return <IdentityStep />;
    case "review":
      return <ReviewStep />;
  }
}
