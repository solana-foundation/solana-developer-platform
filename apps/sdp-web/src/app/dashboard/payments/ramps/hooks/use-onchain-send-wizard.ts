"use client";

import type {
  CounterpartyAccount,
  PaymentsDashboardWallet,
  PaymentTransferSummary,
} from "@sdp/types";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import {
  createTransfer,
  fetchCounterpartyAccounts,
} from "@/app/dashboard/payments/payments-workspace.data";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { useZodForm } from "@/lib/use-zod-form";
import { onchainDestinationSchema, onchainDetailsSchema, onchainSendSchema } from "../schema";
import { walletBalanceAssetOptions } from "../wallet-options";
import { usePaymentsActionWallets } from "./use-payments-action-wallets";
import type { RampWizardStep } from "./use-ramp-wizard";

export type OnchainSendStepId = "DESTINATION" | "DETAILS" | "REVIEW";
type Translate = (key: MessageKey, values?: TranslationValues) => string;

export function getOnchainSendSteps(t: Translate): readonly RampWizardStep[] {
  return [
    {
      id: "DESTINATION",
      label: t("DashboardPayments.onchainSend.destination"),
      title: t("DashboardPayments.onchainSend.destinationTitle"),
    },
    {
      id: "DETAILS",
      label: t("DashboardPayments.onchainSend.details"),
      title: t("DashboardPayments.onchainSend.detailsTitle"),
    },
    {
      id: "REVIEW",
      label: t("DashboardPayments.onchainSend.review"),
      title: t("DashboardPayments.onchainSend.reviewTitle"),
    },
  ];
}

function resolveAccountAddress(account: CounterpartyAccount | null): string {
  if (!account) {
    return "";
  }
  const address = account.details.address;
  return typeof address === "string" ? address : "";
}

export interface UseOnchainSendWizardProps {
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  issuedTokenSymbolsByMint: Record<string, string>;
  counterpartyId: string;
  onExit: () => void;
}

export function useOnchainSendWizard({
  wallets,
  walletsError,
  issuedTokenSymbolsByMint,
  counterpartyId,
  onExit,
}: UseOnchainSendWizardProps) {
  const router = useRouter();
  const t = useTranslations();
  const steps = getOnchainSendSteps(t);
  const [stepIndex, setStepIndex] = useState(0);
  const { values: fields, setField } = useZodForm(onchainSendSchema, {
    accountId: "",
    walletId: "",
    asset: "",
    amount: "",
    memo: "",
  });
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [transferResult, setTransferResult] = useState<PaymentTransferSummary | null>(null);

  const { liveWallets, walletsLoading, liveWalletsError } = usePaymentsActionWallets(
    wallets,
    walletsError
  );

  const {
    data: accounts,
    isLoading: accountsLoading,
    mutate: mutateAccounts,
  } = useSWR(
    counterpartyId ? ["counterparty-accounts", counterpartyId] : null,
    ([, id]: readonly [string, string]) => fetchCounterpartyAccounts(id, t),
    { revalidateOnFocus: false }
  );
  const cryptoAccounts = useMemo(
    () =>
      (accounts ?? []).filter(
        (account) =>
          account.accountKind === "crypto_wallet" &&
          account.status === "active" &&
          resolveAccountAddress(account).length > 0
      ),
    [accounts]
  );

  const selectedWallet = useMemo(
    () => liveWallets.find((wallet) => wallet.walletId === fields.walletId) ?? null,
    [liveWallets, fields.walletId]
  );
  const selectedAccount = useMemo(
    () => cryptoAccounts.find((account) => account.id === fields.accountId) ?? null,
    [cryptoAccounts, fields.accountId]
  );
  const destinationAddress = resolveAccountAddress(selectedAccount);

  const assetOptions = useMemo(
    () => walletBalanceAssetOptions(selectedWallet, issuedTokenSymbolsByMint, t),
    [issuedTokenSymbolsByMint, selectedWallet, t]
  );
  const selectedAsset = useMemo(
    () => assetOptions.find((asset) => asset.value === fields.asset) ?? null,
    [assetOptions, fields.asset]
  );

  const selectWallet = (walletId: string) => {
    setField("walletId", walletId);
    const nextWallet = liveWallets.find((wallet) => wallet.walletId === walletId) ?? null;
    const nextAssets = walletBalanceAssetOptions(nextWallet, issuedTokenSymbolsByMint, t);
    if (!nextAssets.some((asset) => asset.value === fields.asset)) {
      setField("asset", nextAssets[0]?.value ?? "");
    }
  };

  const selectedAssetBalance = useMemo(
    () => selectedWallet?.balances?.find((balance) => balance.mint === fields.asset) ?? null,
    [selectedWallet, fields.asset]
  );

  let availableAmount: number | null = null;
  if (selectedWallet) {
    availableAmount = selectedAssetBalance ? Number(selectedAssetBalance.uiAmount) : 0;
  }
  const numericAmount = Number(fields.amount);
  const exceedsBalance =
    fields.amount.length > 0 && availableAmount !== null && numericAmount > availableAmount;

  const currentStepId = steps[stepIndex].id as OnchainSendStepId;
  const isLastStep = stepIndex === steps.length - 1;

  const canProceed = useMemo(() => {
    if (currentStepId === "DESTINATION") {
      return onchainDestinationSchema.safeParse(fields).success && !!destinationAddress;
    }
    if (currentStepId === "DETAILS") {
      const schemaOk = onchainDetailsSchema.safeParse(fields).success;
      // When a wallet is selected, require a matching balance entry so that
      // submitTransfer always has a mint address rather than falling back to
      // the raw asset string (e.g. "USDC"), which the API would reject.
      const hasMint = !fields.walletId || selectedAssetBalance !== null;
      return schemaOk && !exceedsBalance && hasMint;
    }
    return true;
  }, [currentStepId, fields, destinationAddress, exceedsBalance, selectedAssetBalance]);

  const handleAccountAdded = (account: CounterpartyAccount) => {
    setField("accountId", account.id);
    void mutateAccounts(
      (prev) => [account, ...(prev ?? []).filter((existing) => existing.id !== account.id)],
      { revalidate: true }
    );
    setAddAccountOpen(false);
  };

  const submitTransfer = async () => {
    if (!fields.walletId || !destinationAddress || !selectedAssetBalance) {
      return;
    }
    setSubmitting(true);
    const toastId = toast.loading(t("DashboardPayments.onchainSend.submittingTransfer"), {
      position: "bottom-right",
    });
    try {
      const transfer = await createTransfer(
        {
          source: fields.walletId,
          destination: destinationAddress,
          counterpartyId,
          token: selectedAssetBalance.mint,
          amount: fields.amount,
          ...(fields.memo.trim() ? { memo: fields.memo.trim() } : {}),
        },
        t
      );
      setTransferResult(transfer);
      toast.success(t("DashboardPayments.onchainSend.transferSubmitted"), {
        id: toastId,
        description: transfer.signature
          ? t("DashboardPayments.onchainSend.transactionSent")
          : t("DashboardPayments.onchainSend.transferStatus", { status: transfer.status }),
        position: "bottom-right",
      });
    } catch (error) {
      toast.error(t("DashboardPayments.onchainSend.transferFailed"), {
        id: toastId,
        description:
          error instanceof Error
            ? error.message
            : t("DashboardPayments.onchainSend.transferFailed"),
        position: "bottom-right",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handlePrimary = async () => {
    if (!canProceed) {
      return;
    }
    if (isLastStep) {
      if (transferResult) {
        router.push("/dashboard/payments");
        return;
      }
      await submitTransfer();
      return;
    }
    setStepIndex((current) => current + 1);
  };

  const handleSecondary = () => {
    if (submitting || transferResult) {
      return;
    }
    if (stepIndex === 0) {
      onExit();
      return;
    }
    setStepIndex((current) => Math.max(0, current - 1));
  };

  return {
    stepIndex,
    currentStepId,
    isLastStep,
    canProceed,
    liveWallets,
    walletsLoading,
    liveWalletsError,
    cryptoAccounts,
    accountsLoading,
    counterpartyId,
    selectedWallet,
    selectedAccount,
    destinationAddress,
    assetOptions,
    selectedAsset,
    selectedAssetBalance,
    availableAmount,
    exceedsBalance,
    fields,
    setField,
    selectWallet,
    addAccountOpen,
    setAddAccountOpen,
    handleAccountAdded,
    submitting,
    transferResult,
    handlePrimary,
    handleSecondary,
  };
}

export type OnchainSendWizard = ReturnType<typeof useOnchainSendWizard>;
