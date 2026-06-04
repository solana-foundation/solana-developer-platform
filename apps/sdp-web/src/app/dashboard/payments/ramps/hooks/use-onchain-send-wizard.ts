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
import { isSolBalance } from "@/app/dashboard/payments/payments-overview.utils";
import {
  createTransfer,
  fetchCounterpartyAccounts,
  fetchWallets,
} from "@/app/dashboard/payments/payments-workspace.data";
import type { RampWizardStep } from "./use-ramp-wizard";

export const ONCHAIN_SEND_STEPS = [
  { id: "DESTINATION", label: "Destination", title: "Where should the funds go?" },
  { id: "DETAILS", label: "Details", title: "What would you like to send?" },
  { id: "REVIEW", label: "Review", title: "Review transfer" },
] as const satisfies readonly RampWizardStep[];

export type OnchainSendStepId = (typeof ONCHAIN_SEND_STEPS)[number]["id"];

const PAYMENTS_ACTION_WALLETS_KEY = "payments-action-wallets";

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
  counterpartyId: string;
  onExit: () => void;
}

export function useOnchainSendWizard({
  wallets,
  walletsError,
  counterpartyId,
  onExit,
}: UseOnchainSendWizardProps) {
  const router = useRouter();
  const [stepIndex, setStepIndex] = useState(0);
  const [accountId, setAccountId] = useState("");
  const [walletId, setWalletId] = useState("");
  const [asset, setAsset] = useState("USDC");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [transferResult, setTransferResult] = useState<PaymentTransferSummary | null>(null);

  const { data: swrWallets, error: walletsFetchError } = useSWR<PaymentsDashboardWallet[]>(
    PAYMENTS_ACTION_WALLETS_KEY,
    () => fetchWallets({ includeBalances: true }),
    {
      fallbackData: wallets.length > 0 ? wallets : undefined,
      revalidateOnFocus: false,
      revalidateIfStale: false,
    }
  );
  const liveWallets = swrWallets ?? wallets;
  const walletsLoading = swrWallets === undefined && !walletsFetchError;
  const liveWalletsError = walletsFetchError
    ? walletsFetchError instanceof Error
      ? walletsFetchError.message
      : "Request failed."
    : swrWallets === undefined
      ? walletsError
      : null;

  const {
    data: accounts,
    isLoading: accountsLoading,
    mutate: mutateAccounts,
  } = useSWR(
    counterpartyId ? ["counterparty-accounts", counterpartyId] : null,
    ([, id]: readonly [string, string]) => fetchCounterpartyAccounts(id),
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
    () => liveWallets.find((wallet) => wallet.walletId === walletId) ?? null,
    [liveWallets, walletId]
  );
  const selectedAccount = useMemo(
    () => cryptoAccounts.find((account) => account.id === accountId) ?? null,
    [cryptoAccounts, accountId]
  );
  const destinationAddress = resolveAccountAddress(selectedAccount);

  const assetOptions = useMemo(() => {
    const assetSet = new Set<string>(["USDC"]);
    for (const balance of selectedWallet?.balances ?? []) {
      if (!isSolBalance(balance) && balance.token) {
        assetSet.add(balance.token.trim().toUpperCase());
      }
    }
    return [...assetSet];
  }, [selectedWallet]);

  const selectedAssetBalance = useMemo(
    () =>
      selectedWallet?.balances?.find(
        (balance) => balance.token.trim().toUpperCase() === asset.trim().toUpperCase()
      ) ?? null,
    [selectedWallet, asset]
  );

  const numericAmount = Number.parseFloat(amount);
  const availableAmount = selectedAssetBalance ? Number(selectedAssetBalance.uiAmount) : null;
  const exceedsBalance =
    amount.trim().length > 0 &&
    Number.isFinite(numericAmount) &&
    availableAmount !== null &&
    numericAmount > availableAmount;

  const currentStepId = ONCHAIN_SEND_STEPS[stepIndex].id;
  const isLastStep = stepIndex === ONCHAIN_SEND_STEPS.length - 1;

  const canProceed = useMemo(() => {
    if (currentStepId === "DESTINATION") {
      return !!accountId && !!destinationAddress;
    }
    if (currentStepId === "DETAILS") {
      return (
        !!walletId &&
        !!asset &&
        amount.trim().length > 0 &&
        Number.isFinite(numericAmount) &&
        numericAmount > 0 &&
        !exceedsBalance
      );
    }
    return true;
  }, [
    currentStepId,
    accountId,
    destinationAddress,
    walletId,
    asset,
    amount,
    numericAmount,
    exceedsBalance,
  ]);

  const handleAccountAdded = (account: CounterpartyAccount) => {
    setAccountId(account.id);
    void mutateAccounts();
    setAddAccountOpen(false);
  };

  const submitTransfer = async () => {
    if (!walletId || !destinationAddress) {
      return;
    }
    setSubmitting(true);
    const toastId = toast.loading("Submitting transfer.", { position: "bottom-right" });
    try {
      const transfer = await createTransfer({
        source: walletId,
        destination: destinationAddress,
        token:
          selectedAssetBalance?.mint?.trim() ||
          (asset.trim().toUpperCase() === "SOL" ? "SOL" : asset.trim()) ||
          "SOL",
        amount: amount.trim(),
        ...(memo.trim() ? { memo: memo.trim() } : {}),
      });
      setTransferResult(transfer);
      toast.success("Transfer submitted.", {
        id: toastId,
        description: transfer.signature
          ? "Transaction sent successfully."
          : `Status: ${transfer.status}`,
        position: "bottom-right",
      });
    } catch (error) {
      toast.error("Transfer failed.", {
        id: toastId,
        description: error instanceof Error ? error.message : "Transfer failed.",
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
    selectedAssetBalance,
    availableAmount,
    exceedsBalance,
    accountId,
    setAccountId,
    walletId,
    setWalletId,
    asset,
    setAsset,
    amount,
    setAmount,
    memo,
    setMemo,
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
