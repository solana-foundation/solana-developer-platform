"use client";

import { ArrowLeftIcon, ArrowRightIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCounterpartyCreate } from "../counterparty-create-context";

export function StepFooter() {
  const { step, currentStepId, goBack, submitting } = useCounterpartyCreate();

  const isFirst = step === 0;
  const isReview = currentStepId === "review";

  return (
    <div className="flex items-center justify-between gap-3">
      {isFirst ? (
        <span />
      ) : (
        <Button
          type="button"
          variant="outline"
          onClick={goBack}
          disabled={submitting}
          iconLeft={<ArrowLeftIcon />}
        >
          Back
        </Button>
      )}

      {isReview ? (
        <Button
          type="submit"
          disabled={submitting}
          iconLeft={submitting ? <Loader2Icon className="animate-spin" /> : undefined}
        >
          {submitting ? "Creating" : "Create"}
        </Button>
      ) : (
        <Button type="submit" disabled={submitting} iconRight={<ArrowRightIcon />}>
          Next
        </Button>
      )}
    </div>
  );
}
