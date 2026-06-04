"use client";

import { AnimatePresence, motion } from "motion/react";
import { StepContent } from "./components/step-content";
import { StepFooter } from "./components/step-footer";
import { StepIndicator } from "./components/step-indicator";
import { useCounterpartyCreate } from "./counterparty-create-context";
import type { StepId } from "./counterparty-create-schemas";
import { CryptoAccountsPhase } from "./crypto-accounts-phase";

const stepMeta: Record<StepId, { label: string; title: string; description: string }> = {
  basics: {
    label: "Basics",
    title: "Basic info",
    description: "Enter the counterparty's name and contact details.",
  },
  identity: {
    label: "Personal",
    title: "Personal details",
    description: "Identity information for this individual.",
  },
  address: {
    label: "Address",
    title: "Location",
    description: "Helps us verify who they are and where they're based.",
  },
  compliance: {
    label: "Compliance",
    title: "Tax & compliance",
    description: "US residents need additional KYC details to fund on-ramps.",
  },
  review: {
    label: "Review",
    title: "Review & create",
    description: "Confirm everything looks right before creating.",
  },
};

const variants = {
  initial: (direction: number) => ({ x: direction * 32, opacity: 0 }),
  animate: { x: 0, opacity: 1 },
  exit: (direction: number) => ({ x: direction * -32, opacity: 0 }),
};

export function CounterpartyCreatePage() {
  const { step, steps, currentStepId, direction, createdCounterparty } = useCounterpartyCreate();

  if (createdCounterparty) {
    return <CryptoAccountsPhase />;
  }

  return (
    <div className="mx-auto flex h-[80vh] max-w-xl flex-col py-4">
      <StepIndicator steps={steps} step={step} />

      <div className="relative mt-6 min-h-0 flex-1 overflow-hidden">
        <AnimatePresence mode="wait" custom={direction}>
          <motion.div
            key={currentStepId}
            custom={direction}
            variants={variants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="absolute inset-0 space-y-6 overflow-y-auto px-1 py-1"
          >
            <div className="space-y-1">
              <h2 className="text-2xl font-medium tracking-tight text-text-extra-high">
                {stepMeta[currentStepId].title}
              </h2>
              <p className="text-sm text-text-medium">{stepMeta[currentStepId].description}</p>
            </div>
            <StepContent stepId={currentStepId} />
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="mt-6">
        <StepFooter />
      </div>
    </div>
  );
}
