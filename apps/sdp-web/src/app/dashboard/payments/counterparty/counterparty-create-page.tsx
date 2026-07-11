"use client";

import { AnimatePresence, motion } from "motion/react";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { StepContent } from "./components/step-content";
import { StepFooter } from "./components/step-footer";
import { StepIndicator } from "./components/step-indicator";
import { useCounterpartyCreate } from "./counterparty-create-context";
import type { StepId } from "./counterparty-create-schemas";
import { CryptoAccountsPhase } from "./crypto-accounts-phase";

const stepMeta: Record<StepId, { label: MessageKey; title: MessageKey; description: MessageKey }> =
  {
    basics: {
      label: "DashboardPayments.counterparty.basics",
      title: "DashboardPayments.counterparty.basicInfo",
      description: "DashboardPayments.counterparty.basicInfoDescription",
    },
    identity: {
      label: "DashboardPayments.counterparty.personal",
      title: "DashboardPayments.counterparty.personalDetails",
      description: "DashboardPayments.counterparty.personalDetailsDescription",
    },
    address: {
      label: "DashboardPayments.counterparty.address",
      title: "DashboardPayments.counterparty.location",
      description: "DashboardPayments.counterparty.locationDescription",
    },
    review: {
      label: "DashboardPayments.counterparty.review",
      title: "DashboardPayments.counterparty.reviewCreate",
      description: "DashboardPayments.counterparty.reviewCreateDescription",
    },
  };

const variants = {
  initial: (direction: number) => ({ x: direction * 32, opacity: 0 }),
  animate: { x: 0, opacity: 1 },
  exit: (direction: number) => ({ x: direction * -32, opacity: 0 }),
};

export function CounterpartyCreatePage() {
  const t = useTranslations();
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
                {t(stepMeta[currentStepId].title)}
              </h2>
              <p className="text-sm text-text-medium">{t(stepMeta[currentStepId].description)}</p>
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
