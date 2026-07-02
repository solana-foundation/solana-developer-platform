"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { usePaymentsActionWallets } from "./use-payments-action-wallets";
import type { RampWizardStep } from "./use-ramp-wizard";

export const ONCHAIN_RECEIVE_STEPS = [
  { id: "WALLET", label: "Wallet", title: "Which wallet should receive funds?" },
  { id: "RECEIVE", label: "Receive", title: "Receive funds onchain" },
] as const satisfies readonly RampWizardStep[];

export type OnchainReceiveStepId = (typeof ONCHAIN_RECEIVE_STEPS)[number]["id"];

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

  const currentStepId = ONCHAIN_RECEIVE_STEPS[stepIndex].id;
  const isLastStep = stepIndex === ONCHAIN_RECEIVE_STEPS.length - 1;
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
