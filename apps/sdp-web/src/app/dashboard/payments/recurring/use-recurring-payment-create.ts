"use client";

import { compareDecimalAmounts, decimalScale, isDecimalString } from "@sdp/solana/amount";
import type {
  Counterparty,
  CounterpartyAccount,
  PaymentRecurringPaymentSchedulePreset,
  PaymentsDashboardWallet,
} from "@sdp/types";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import useSWR, { preload } from "swr";
import { paymentsQueryKeys } from "@/app/dashboard/payments/payments-query-key";
import type { BadgeVariant } from "@/components/ui/badge";
import type { ComboboxOption } from "@/components/ui/combobox";
import { useTranslations } from "@/i18n/provider";
import { isSolBalance, resolveTokenByMint, resolveTotalBalance } from "../payments-overview.utils";
import type { PaymentsIssuedTokenSymbol } from "../payments-page.data";
import {
  type CounterpartiesResult,
  fetchAllCounterparties,
  fetchCounterpartyAccounts,
} from "../payments-workspace.data";
import { usePaymentsActionWallets } from "../ramps/hooks/use-payments-action-wallets";
import { walletBalanceAssetOptions, walletComboboxOptions } from "../ramps/wallet-options";
import { createRecurringPayment } from "./recurring-payments.data";
import { accountAddress, getSchedulePresets, parsePeriodHours } from "./recurring-payments-shared";

export interface RecurringPaymentCreateInput {
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  issuedTokenSymbolsByMint: Record<string, string>;
  issuedTokensByMint: Record<string, PaymentsIssuedTokenSymbol>;
  counterpartiesResult: CounterpartiesResult;
}

export type RecurringPaymentCreateStepId = "payment" | "when" | "review";

export type SchedulePreset = PaymentRecurringPaymentSchedulePreset;

export interface RecurringPaymentCreateFields {
  counterpartyId: string;
  counterpartyAccountId: string;
  sourceCustodyWalletId: string;
  token: string;
  amount: string;
  schedulePreset: SchedulePreset;
  customPeriodHours: string;
  firstCollectionAt: string;
}

type WalletBalance = NonNullable<PaymentsDashboardWallet["balances"]>[number];

type Translate = ReturnType<typeof useTranslations>;

export function recurringPaymentAssetOptions(
  wallet: PaymentsDashboardWallet | null,
  issuedTokenSymbolsByMint: Record<string, string>,
  t: Translate
): ComboboxOption[] {
  const walletWithoutSol = wallet
    ? { ...wallet, balances: wallet.balances?.filter((balance) => !isSolBalance(balance)) }
    : null;

  return walletBalanceAssetOptions(walletWithoutSol, issuedTokenSymbolsByMint, t, {
    hideUnresolvedMints: true,
  });
}

export function resolveScheduleLabel(
  fields: RecurringPaymentCreateFields,
  t: Translate,
  schedulePresets: readonly { value: SchedulePreset; label: string }[]
): string {
  if (fields.schedulePreset !== "custom") {
    return (
      schedulePresets.find((preset) => preset.value === fields.schedulePreset)?.label ??
      t("DashboardPayments.recurring.notSet")
    );
  }
  const periodHours = parsePeriodHours(fields.schedulePreset, fields.customPeriodHours);
  if (!periodHours) {
    return t("DashboardPayments.recurring.customInterval");
  }
  return periodHours === 1
    ? t("DashboardPayments.recurring.everyHour")
    : t("DashboardPayments.recurring.everyHours", { count: periodHours });
}

export type AmountValidationError = "format" | "notPositive" | "decimals";

/** Max fractional digits accepted before a selected asset bounds the precision (the on-chain 9-decimal cap). */
const AMOUNT_PATTERN_MAX_DECIMALS = 9;

function amountError(value: string, maxDecimals: number): AmountValidationError | null {
  const trimmed = value.trim();
  if (!isDecimalString(trimmed)) {
    return "format";
  }
  if (decimalScale(trimmed) > maxDecimals) {
    return "decimals";
  }
  return compareDecimalAmounts(trimmed, "0") > 0 ? null : "notPositive";
}

export function amountErrorMessage(
  error: AmountValidationError,
  maxDecimals: number,
  t: Translate
): string {
  switch (error) {
    case "decimals":
      return t("DashboardPayments.recurring.invalidAmountDecimals", { decimals: maxDecimals });
    case "notPositive":
      return t("DashboardPayments.recurring.invalidAmount");
    case "format":
      return t("DashboardPayments.recurring.invalidAmountFormat");
    default: {
      const exhaustive: never = error;
      throw new Error(`Unhandled amount error: ${exhaustive}`);
    }
  }
}

export function firstCollectionAtIsValid(value: string): boolean {
  if (!value) {
    return true;
  }
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

/**
 * New schedule's state: the fields, what they resolve to, and the actions on them. The
 * destination account and the token are resolved from the fields during render rather than
 * written back by effects: a contact with one Solana address pays to it (several ask which;
 * none says so), and a wallet whose balances arrive later keeps the token that is still there.
 *
 * @param input - The page's wallets, contacts and token names.
 * @returns Everything the steps and the frame read and call.
 */
export function useRecurringPaymentCreate({
  wallets,
  walletsError,
  issuedTokenSymbolsByMint,
  issuedTokensByMint,
  counterpartiesResult,
}: RecurringPaymentCreateInput) {
  const t = useTranslations();
  const steps = [
    { id: "payment", label: t("DashboardPayments.recurring.paymentStep"), title: "" },
    { id: "when", label: t("DashboardPayments.recurring.whenStep"), title: "" },
    { id: "review", label: t("DashboardPayments.counterparty.review"), title: "" },
  ] as const satisfies readonly {
    id: RecurringPaymentCreateStepId;
    label: string;
    title: string;
  }[];
  const schedulePresets = useMemo(() => getSchedulePresets(t), [t]);
  const router = useRouter();
  const [stepIndex, setStepIndex] = useState(0);
  const [counterpartyDialogOpen, setCounterpartyDialogOpen] = useState(false);
  const [destinationAccountDialogOpen, setDestinationAccountDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fields, setFields] = useState<RecurringPaymentCreateFields>({
    counterpartyId: "",
    counterpartyAccountId: "",
    sourceCustodyWalletId: "",
    token: "",
    amount: "",
    schedulePreset: "24",
    customPeriodHours: "",
    firstCollectionAt: "",
  });

  const { data: liveCounterpartiesResult, mutate: mutateCounterparties } = useSWR(
    paymentsQueryKeys.actionCounterparties(),
    fetchAllCounterparties,
    {
      fallbackData: counterpartiesResult,
    }
  );
  const liveCounterparties =
    liveCounterpartiesResult === undefined ? counterpartiesResult : liveCounterpartiesResult;

  const { liveWallets: availableWallets, liveWalletsError } = usePaymentsActionWallets(
    wallets,
    walletsError
  );

  const {
    data: accounts,
    isLoading: accountsLoading,
    mutate: mutateAccounts,
  } = useSWR(
    fields.counterpartyId
      ? paymentsQueryKeys.counterpartyAccounts({ counterpartyId: fields.counterpartyId })
      : null,
    ([, id]: readonly [string, string]) => fetchCounterpartyAccounts(id, t),
    { revalidateOnFocus: false }
  );

  const cryptoAccounts = useMemo(
    () =>
      (accounts === undefined ? [] : accounts).filter(
        (account) =>
          account.accountKind === "crypto_wallet" &&
          account.status === "active" &&
          accountAddress(account).length > 0
      ),
    [accounts]
  );
  // The chosen account while the contact still has it; else the contact's only one; else none.
  const resolvedAccountId = cryptoAccounts.some(
    (account) => account.id === fields.counterpartyAccountId
  )
    ? fields.counterpartyAccountId
    : cryptoAccounts.length === 1
      ? cryptoAccounts[0].id
      : "";

  const foundCounterparty = liveCounterparties.data.find(
    (counterparty) => counterparty.id === fields.counterpartyId
  );
  const selectedCounterparty = foundCounterparty === undefined ? null : foundCounterparty;
  const foundAccount = cryptoAccounts.find((account) => account.id === resolvedAccountId);
  const selectedAccount = foundAccount === undefined ? null : foundAccount;
  const foundWallet = availableWallets.find((wallet) => wallet.id === fields.sourceCustodyWalletId);
  const selectedWallet = foundWallet === undefined ? null : foundWallet;
  const selectedWalletTotal =
    selectedWallet === null ? null : resolveTotalBalance(selectedWallet.balances ?? []);

  const walletOptions = useMemo(
    () => walletComboboxOptions(availableWallets, t("DashboardPayments.restricted")),
    [availableWallets, t]
  );
  const assetOptions = useMemo<ComboboxOption[]>(
    () => recurringPaymentAssetOptions(selectedWallet, issuedTokenSymbolsByMint, t),
    [issuedTokenSymbolsByMint, selectedWallet, t]
  );
  const assetSelectOptions = useMemo(
    () =>
      assetOptions.map((asset) => {
        const token = resolveTokenByMint(asset.value, issuedTokensByMint, asset.label);
        let badge: string | undefined;
        let badgeVariant: BadgeVariant | undefined;
        if (token.tokenId !== null) {
          badge = t("Shared.SharedComponents.sdpMintedToken");
          badgeVariant = "outline";
        } else if (!token.isWellKnown) {
          badge = t("Shared.SharedComponents.unknownToken");
        }
        return { value: asset.value, label: token.tokenName, badge, badgeVariant };
      }),
    [assetOptions, issuedTokensByMint, t]
  );
  const nonSolBalanceCount =
    selectedWallet?.balances?.filter((balance) => !isSolBalance(balance)).length ?? 0;

  // The chosen token while the wallet still holds it; else the wallet's first; none without a
  // wallet.
  const resolvedToken = fields.sourceCustodyWalletId
    ? assetOptions.some((asset) => asset.value === fields.token)
      ? fields.token
      : (assetOptions[0]?.value ?? "")
    : "";
  const foundAsset = assetOptions.find((asset) => asset.value === resolvedToken);
  const selectedAsset = foundAsset === undefined ? null : foundAsset;
  const selectedAssetBalance = useMemo<WalletBalance | null>(
    () =>
      selectedAsset
        ? (selectedWallet?.balances?.find((balance) => balance.mint === resolvedToken) ?? null)
        : null,
    [resolvedToken, selectedAsset, selectedWallet]
  );
  const maxAmountDecimals = selectedAssetBalance
    ? selectedAssetBalance.decimals
    : AMOUNT_PATTERN_MAX_DECIMALS;
  const amountValidationError = amountError(fields.amount, maxAmountDecimals);
  const exceedsBalance =
    isDecimalString(fields.amount) &&
    selectedAssetBalance !== null &&
    compareDecimalAmounts(fields.amount, selectedAssetBalance.uiAmount) > 0;
  const periodHours = parsePeriodHours(fields.schedulePreset, fields.customPeriodHours);
  const currentStep = steps[stepIndex];
  const assetSelectPlaceholder = fields.sourceCustodyWalletId
    ? assetOptions.length === 0
      ? t("DashboardPayments.recurring.noTokenBalances")
      : t("DashboardPayments.recurring.selectAsset")
    : t("DashboardPayments.recurring.selectWalletFirst");

  const setField = <TKey extends keyof RecurringPaymentCreateFields>(
    key: TKey,
    value: RecurringPaymentCreateFields[TKey]
  ) => {
    setFormError(null);
    setFields((current) => ({ ...current, [key]: value }));
  };

  const selectCounterparty = (counterpartyId: string) => {
    setFields((current) => ({
      ...current,
      counterpartyId,
      counterpartyAccountId: "",
    }));
    setFormError(null);
    if (counterpartyId) {
      void preload(paymentsQueryKeys.counterpartyAccounts({ counterpartyId }), () =>
        fetchCounterpartyAccounts(counterpartyId, t)
      );
    }
  };

  const selectWallet = (sourceCustodyWalletId: string) => {
    const foundWallet = availableWallets.find((entry) => entry.id === sourceCustodyWalletId);
    const wallet = foundWallet === undefined ? null : foundWallet;
    const nextAssets = recurringPaymentAssetOptions(wallet, issuedTokenSymbolsByMint, t);
    setFields((current) => ({
      ...current,
      sourceCustodyWalletId,
      token: nextAssets.some((asset) => asset.value === current.token)
        ? current.token
        : (nextAssets[0]?.value ?? ""),
    }));
    setFormError(null);
  };

  const handleCounterpartyCreated = (created: Counterparty) => {
    selectCounterparty(created.id);
    void mutateCounterparties(
      (previous) =>
        previous
          ? { ...previous, data: [created, ...previous.data] }
          : { ok: true, data: [created] },
      { revalidate: true }
    );
    setCounterpartyDialogOpen(false);
  };

  const handleDestinationAccountAdded = (account: CounterpartyAccount) => {
    setFields((current) => ({
      ...current,
      counterpartyAccountId: account.id,
    }));
    setFormError(null);
    setDestinationAccountDialogOpen(false);
    void mutateAccounts((previous) => [account, ...(previous ?? [])], { revalidate: true });
  };

  const canProceed = useMemo(() => {
    if (currentStep.id === "payment") {
      return Boolean(
        fields.counterpartyId &&
          resolvedAccountId &&
          accountAddress(selectedAccount) &&
          fields.sourceCustodyWalletId &&
          resolvedToken &&
          selectedAssetBalance &&
          amountValidationError === null
      );
    }
    if (currentStep.id === "when") {
      return Boolean(periodHours && firstCollectionAtIsValid(fields.firstCollectionAt));
    }
    return true;
  }, [
    amountValidationError,
    currentStep.id,
    fields,
    periodHours,
    resolvedAccountId,
    resolvedToken,
    selectedAccount,
    selectedAssetBalance,
  ]);

  const submitRecurringPayment = async () => {
    if (!periodHours || !selectedAccount || !selectedAssetBalance) {
      return;
    }

    setSubmitting(true);
    setFormError(null);
    const toastId = toast.loading(t("DashboardPayments.recurring.creatingPayment"), {
      position: "bottom-right",
    });
    try {
      const recurringPayment = await createRecurringPayment(
        {
          sourceCustodyWalletId: fields.sourceCustodyWalletId,
          counterpartyId: fields.counterpartyId,
          counterpartyAccountId: resolvedAccountId,
          token: selectedAssetBalance.mint,
          amount: fields.amount.trim(),
          periodHours,
          ...(fields.firstCollectionAt
            ? { firstCollectionAt: new Date(fields.firstCollectionAt).toISOString() }
            : {}),
        },
        undefined,
        t
      );
      toast.success(t("DashboardPayments.recurring.paymentCreated"), {
        id: toastId,
        description: t("DashboardPayments.recurring.pendingActivationDescription"),
        position: "bottom-right",
      });
      router.push(`/dashboard/payments/recurring/${encodeURIComponent(recurringPayment.id)}`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t("DashboardPayments.recurring.unableToCreate");
      setFormError(message);
      toast.error(t("DashboardPayments.recurring.paymentNotCreated"), {
        id: toastId,
        description: message,
        position: "bottom-right",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handlePrimary = async () => {
    if (!canProceed || submitting) {
      return;
    }
    const stepId: RecurringPaymentCreateStepId = currentStep.id;
    switch (stepId) {
      case "payment":
      case "when":
        setStepIndex((current) => current + 1);
        return;
      case "review":
        await submitRecurringPayment();
        return;
      default: {
        const exhaustive: never = stepId;
        throw new Error(`Unhandled recurring payment step: ${String(exhaustive)}`);
      }
    }
  };

  const exitToSchedules = () => {
    if (!submitting) {
      router.push("/dashboard/payments/recurring");
    }
  };

  const handleSecondary = () => {
    if (submitting) {
      return;
    }
    if (stepIndex === 0) {
      exitToSchedules();
      return;
    }
    setStepIndex((current) => Math.max(0, current - 1));
  };

  return {
    steps,
    stepIndex,
    currentStep,
    schedulePresets,
    fields,
    setField,
    selectCounterparty,
    selectWallet,
    liveCounterparties,
    liveWalletsError,
    availableWallets,
    accountsLoading,
    cryptoAccounts,
    resolvedAccountId,
    selectedAccount,
    selectedCounterparty,
    selectedWallet,
    selectedWalletTotal,
    walletOptions,
    assetOptions,
    assetSelectOptions,
    assetSelectPlaceholder,
    resolvedToken,
    selectedAsset,
    selectedAssetBalance,
    maxAmountDecimals,
    amountValidationError,
    exceedsBalance,
    nonSolBalanceCount,
    periodHours,
    canProceed,
    submitting,
    formError,
    counterpartyDialogOpen,
    setCounterpartyDialogOpen,
    destinationAccountDialogOpen,
    setDestinationAccountDialogOpen,
    handleCounterpartyCreated,
    handleDestinationAccountAdded,
    handlePrimary,
    handleSecondary,
    exitToSchedules,
  };
}

export type RecurringPaymentCreateForm = ReturnType<typeof useRecurringPaymentCreate>;
