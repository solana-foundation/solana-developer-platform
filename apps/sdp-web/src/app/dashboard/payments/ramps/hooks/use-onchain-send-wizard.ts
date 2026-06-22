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
import { useZodForm } from "@/lib/use-zod-form";
import { onchainDestinationSchema, onchainDetailsSchema, onchainSendSchema } from "../schema";
import { findWalletBalanceForToken } from "../wallet-options";
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

function resolveWalletAssets(wallet: PaymentsDashboardWallet | null): string[] {
  const assetSet = new Set<string>(["USDC"]);
  for (const balance of wallet?.balances ?? []) {
    if (!isSolBalance(balance) && balance.token) {
      assetSet.add(balance.token);
    }
  }
  return [...assetSet];
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
  const { values: fields, setField } = useZodForm(onchainSendSchema, {
    accountId: "",
    walletId: "",
    asset: "USDC",
    amount: "",
    memo: "",
  });
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
    () => liveWallets.find((wallet) => wallet.walletId === fields.walletId) ?? null,
    [liveWallets, fields.walletId]
  );
  const selectedAccount = useMemo(
    () => cryptoAccounts.find((account) => account.id === fields.accountId) ?? null,
    [cryptoAccounts, fields.accountId]
  );
  const destinationAddress = resolveAccountAddress(selectedAccount);

  const assetOptions = useMemo(() => resolveWalletAssets(selectedWallet), [selectedWallet]);

  const selectWallet = (walletId: string) => {
    setField("walletId", walletId);
    const nextWallet = liveWallets.find((wallet) => wallet.walletId === walletId) ?? null;
    const nextAssets = resolveWalletAssets(nextWallet);
    if (!nextAssets.includes(fields.asset)) {
      setField("asset", nextAssets[0] ?? "");
    }
  };

  const selectedAssetBalance = useMemo(
    () => findWalletBalanceForToken(selectedWallet, fields.asset),
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
    if (!fields.walletId || !destinationAddress) {
      return;
    }
    setSubmitting(true);
    const toastId = toast.loading("Submitting transfer.", { position: "bottom-right" });
    try {
      const transfer = await createTransfer({
        source: fields.walletId,
        destination: destinationAddress,
        token: selectedAssetBalance?.mint ?? (fields.asset === "SOL" ? "SOL" : fields.asset),
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
