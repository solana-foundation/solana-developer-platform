"use client";

import { AnimatePresence, motion } from "motion/react";
import { StepContent } from "./components/step-content";
import { StepIndicator } from "./components/step-indicator";
import { useCounterpartyCreate } from "./counterparty-create-context";
import type { StepId } from "./counterparty-create-schemas";

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
  const { step, steps, currentStepId, direction } = useCounterpartyCreate();

  return (
    <div className="mx-auto max-w-xl py-4 space-y-6">
      <StepIndicator steps={steps} step={step} />

      <AnimatePresence mode="wait" custom={direction}>
        <motion.div
          key={currentStepId}
          custom={direction}
          variants={variants}
          initial="initial"
          animate="animate"
          exit="exit"
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="space-y-6"
        >
          <div className="space-y-1">
            <h2 className="text-[28px] leading-[32px] font-medium tracking-[-0.3px] text-text-extra-high">
              {stepMeta[currentStepId].title}
            </h2>
            <p className="text-sm text-text-medium">{stepMeta[currentStepId].description}</p>
          </div>
          <StepContent stepId={currentStepId} />
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
