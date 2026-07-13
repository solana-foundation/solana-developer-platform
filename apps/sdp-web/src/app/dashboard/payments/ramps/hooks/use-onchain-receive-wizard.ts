"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { usePaymentsActionWallets } from "./use-payments-action-wallets";
import type { RampWizardStep } from "./use-ramp-wizard";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

export const ONCHAIN_RECEIVE_STEP_IDS = ["WALLET", "RECEIVE"] as const;

export type OnchainReceiveStepId = (typeof ONCHAIN_RECEIVE_STEP_IDS)[number];

export function getOnchainReceiveSteps(
  t: Translate
): readonly RampWizardStep<OnchainReceiveStepId>[] {
  return [
    {
      id: "WALLET",
      label: t("DashboardPayments.onchainReceive.wallet"),
      title: t("DashboardPayments.onchainReceive.walletTitle"),
    },
    {
      id: "RECEIVE",
      label: t("DashboardPayments.onchainReceive.receive"),
      title: t("DashboardPayments.onchainReceive.receiveTitle"),
    },
  ];
}

export interface UseOnchainReceiveWizardProps {
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  counterpartyId: string;
  onExit: () => void;
}

export function useOnchainReceiveWizard({
  wallets,
  walletsError,
  counterpartyId,
  onExit,
}: UseOnchainReceiveWizardProps) {
  const router = useRouter();
  const t = useTranslations();
  const steps = getOnchainReceiveSteps(t);
  const [stepIndex, setStepIndex] = useState(0);
  const [walletId, setWalletId] = useState("");

  const { liveWallets, walletsLoading, liveWalletsError } = usePaymentsActionWallets(
    wallets,
    walletsError
  );

  const selectedWallet = useMemo(
    () => liveWallets.find((wallet) => wallet.walletId === walletId) ?? null,
    [liveWallets, walletId]
  );

  const currentStepId = steps[stepIndex].id;
  const isLastStep = stepIndex === steps.length - 1;
  const canProceed = currentStepId === "WALLET" ? !!walletId : true;

  const handlePrimary = () => {
    if (!canProceed) {
      return;
    }
    if (isLastStep) {
      router.push("/dashboard/payments");
      return;
    }
    setStepIndex((current) => current + 1);
  };

  const handleSecondary = () => {
    if (stepIndex === 0) {
      onExit();
      return;
    }
    setStepIndex((current) => Math.max(0, current - 1));
  };

  return {
    counterpartyId,
    stepIndex,
    steps,
    currentStepId,
    isLastStep,
    canProceed,
    liveWallets,
    walletsLoading,
    liveWalletsError,
    selectedWallet,
    walletId,
    setWalletId,
    handlePrimary,
    handleSecondary,
  };
}

export type OnchainReceiveWizard = ReturnType<typeof useOnchainReceiveWizard>;
