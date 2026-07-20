"use client";

import { AnimatePresence, motion } from "motion/react";
import { PaymentsWizardFrame } from "@/app/dashboard/payments/payments-wizard-frame";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { StepContent } from "./components/step-content";
import { StepFooter } from "./components/step-footer";
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

interface CounterpartyCreatePageProps {
  embedded?: boolean;
  onCancel?: () => void;
}

export function CounterpartyCreatePage({
  embedded = false,
  onCancel,
}: CounterpartyCreatePageProps) {
  const t = useTranslations();
  const { step, steps, currentStepId, direction, createdCounterparty } = useCounterpartyCreate();
  const wizardSteps = steps.map((stepId) => ({
    label: t(stepMeta[stepId].label),
    title: t(stepMeta[stepId].title),
  }));

  if (createdCounterparty) {
    return <CryptoAccountsPhase embedded={embedded} steps={wizardSteps} />;
  }

  return (
    <PaymentsWizardFrame
      steps={wizardSteps}
      currentStep={step}
      progressLabel={t("DashboardPayments.counterparty.stepProgress", {
        current: step + 1,
        total: steps.length,
      })}
      description={t(stepMeta[currentStepId].description)}
      footer={<StepFooter onCancel={onCancel} />}
      maxWidthClassName="max-w-xl"
    >
      <div className="relative min-h-[20rem] overflow-hidden">
        <AnimatePresence mode="wait" custom={direction}>
          <motion.div
            key={currentStepId}
            custom={direction}
            variants={variants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="space-y-6 px-1 py-1"
          >
            <StepContent stepId={currentStepId} />
          </motion.div>
        </AnimatePresence>
      </div>
    </PaymentsWizardFrame>
  );
}
