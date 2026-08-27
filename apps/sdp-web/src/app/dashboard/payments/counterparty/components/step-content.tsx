"use client";

import type { StepId } from "../counterparty-create-schemas";
import { BasicsStep } from "../steps/basics-step";
import { ReviewStep } from "../steps/review-step";

export function StepContent({ stepId }: { stepId: StepId }) {
  switch (stepId) {
    case "basics":
      return <BasicsStep />;
    case "review":
      return <ReviewStep />;
  }
}
