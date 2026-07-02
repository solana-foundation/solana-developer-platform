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
import { useZodForm } from "@/lib/use-zod-form";
import { onchainDestinationSchema, onchainDetailsSchema, onchainSendSchema } from "../schema";
import { walletBalanceAssetOptions } from "../wallet-options";
import { usePaymentsActionWallets } from "./use-payments-action-wallets";
import type { RampWizardStep } from "./use-ramp-wizard";

export const ONCHAIN_SEND_STEPS = [
  { id: "DESTINATION", label: "Destination", title: "Where should the funds go?" },
  { id: "DETAILS", label: "Details", title: "What would you like to send?" },
  { id: "REVIEW", label: "Review", title: "Review transfer" },
] as const satisfies readonly RampWizardStep[];

export type OnchainSendStepId = (typeof ONCHAIN_SEND_STEPS)[number]["id"];

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
    () => liveWallets.find((wallet) => wallet.walletId === fields.walletId) ?? null,
    [liveWallets, fields.walletId]
  );
  const selectedAccount = useMemo(
    () => cryptoAccounts.find((account) => account.id === fields.accountId) ?? null,
    [cryptoAccounts, fields.accountId]
  );
  const destinationAddress = resolveAccountAddress(selectedAccount);

  const assetOptions = useMemo(
    () => walletBalanceAssetOptions(selectedWallet, issuedTokenSymbolsByMint),
    [issuedTokenSymbolsByMint, selectedWallet]
  );
  const selectedAsset = useMemo(
    () => assetOptions.find((asset) => asset.value === fields.asset) ?? null,
    [assetOptions, fields.asset]
  );

  const selectWallet = (walletId: string) => {
    setField("walletId", walletId);
    const nextWallet = liveWallets.find((wallet) => wallet.walletId === walletId) ?? null;
    const nextAssets = walletBalanceAssetOptions(nextWallet, issuedTokenSymbolsByMint);
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

  const currentStepId = ONCHAIN_SEND_STEPS[stepIndex].id;
  const isLastStep = stepIndex === ONCHAIN_SEND_STEPS.length - 1;

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
    const toastId = toast.loading("Submitting transfer.", { position: "bottom-right" });
    try {
      const transfer = await createTransfer({
        source: fields.walletId,
        destination: destinationAddress,
        token: selectedAssetBalance.mint,
        amount: fields.amount,
        ...(fields.memo.trim() ? { memo: fields.memo.trim() } : {}),
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
