"use client";

import type { Counterparty, CounterpartyAccount, PaymentsDashboardWallet } from "@sdp/types";
import { CreditCardIcon, PlusIcon, RepeatIcon, WalletIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import useSWR, { preload } from "swr";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/i18n/provider";
import { AddExternalAccountDialog } from "../counterparty/add-external-account-dialog";
import { isSolBalance, shortenAddress } from "../payments-overview.utils";
import {
  type CounterpartiesResult,
  fetchAllCounterparties,
  fetchCounterpartyAccounts,
  fetchWallets,
} from "../payments-workspace.data";
import { CounterpartyPicker } from "../ramps/components/counterparty-picker";
import { RampWizardShell } from "../ramps/components/ramp-wizard-shell";
import {
  PAYMENTS_ACTION_WALLETS_KEY,
  usePaymentsActionWallets,
} from "../ramps/hooks/use-payments-action-wallets";
import { ONCHAIN_AMOUNT_PATTERN } from "../ramps/schema";
import { walletBalanceAssetOptions } from "../ramps/wallet-options";
import { createRecurringPayment } from "./recurring-payments.data";

interface RecurringPaymentCreateWorkspaceProps {
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  issuedTokenSymbolsByMint: Record<string, string>;
  counterpartiesResult: CounterpartiesResult;
}

type StepId = "counterparty" | "destination" | "details" | "review";

type SchedulePreset = "24" | "168" | "720" | "custom";

interface RecurringPaymentCreateFields {
  counterpartyId: string;
  counterpartyAccountId: string;
  walletId: string;
  token: string;
  amount: string;
  schedulePreset: SchedulePreset;
  customPeriodHours: string;
  firstCollectionAt: string;
  metadataUri: string;
}

type WalletBalance = NonNullable<PaymentsDashboardWallet["balances"]>[number];

const PAYMENTS_ACTION_COUNTERPARTIES_KEY = "payments-action-counterparties";

function resolveAccountAddress(account: CounterpartyAccount | null): string {
  if (!account) {
    return "";
  }
  const address = account.details.address;
  return typeof address === "string" ? address : "";
}

function resolvePeriodHours(fields: RecurringPaymentCreateFields): number | null {
  const rawValue =
    fields.schedulePreset === "custom" ? fields.customPeriodHours : fields.schedulePreset;
  if (!/^\d+$/.test(rawValue.trim())) {
    return null;
  }
  const value = Number(rawValue);
  return Number.isInteger(value) && value > 0 && value <= 24 * 365 ? value : null;
}

function resolveScheduleLabel(
  fields: RecurringPaymentCreateFields,
  t: ReturnType<typeof useTranslations>,
  schedulePresets: readonly { value: SchedulePreset; label: string }[]
): string {
  if (fields.schedulePreset !== "custom") {
    return (
      schedulePresets.find((preset) => preset.value === fields.schedulePreset)?.label ??
      t("DashboardPayments.recurring.notSet")
    );
  }
  const periodHours = resolvePeriodHours(fields);
  if (!periodHours) {
    return t("DashboardPayments.recurring.customInterval");
  }
  return periodHours === 1
    ? t("DashboardPayments.recurring.everyHour")
    : t("DashboardPayments.recurring.everyHours", { count: periodHours });
}

function amountIsValid(value: string): boolean {
  return ONCHAIN_AMOUNT_PATTERN.test(value.trim()) && Number(value) > 0;
}

function metadataUriIsValid(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return true;
  }
  if (trimmed.length > 128) {
    return false;
  }
  try {
    new URL(trimmed);
    return true;
  } catch {
    return false;
  }
}

function firstCollectionAtIsValid(value: string): boolean {
  if (!value) {
    return true;
  }
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

function ReviewSummaryCard({ rows }: { rows: Array<{ label: string; value: ReactNode }> }) {
  return (
    <section className="rounded-2xl border border-border-light bg-border-extra-light p-5">
      <div className="divide-y divide-border-extra-light">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0"
          >
            <p className="text-sm text-text-low">{row.label}</p>
            <div className="min-w-0 text-right text-base font-medium text-text-extra-high">
              {row.value}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function FieldHint({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "error";
}) {
  return (
    <p className={tone === "error" ? "text-sm text-status-error-text" : "text-sm text-text-low"}>
      {children}
    </p>
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This wizard intentionally keeps shared form state in one place while each step remains simple.
export function RecurringPaymentCreateWorkspace({
  wallets,
  walletsError,
  issuedTokenSymbolsByMint,
  counterpartiesResult,
}: RecurringPaymentCreateWorkspaceProps) {
  const t = useTranslations();
  const createSteps = [
    {
      id: "counterparty",
      label: t("DashboardPayments.counterpartyLabel"),
      title: t("DashboardPayments.recurring.counterpartyStepTitle"),
    },
    {
      id: "destination",
      label: t("DashboardPayments.recurring.destination"),
      title: t("DashboardPayments.recurring.destinationStepTitle"),
    },
    {
      id: "details",
      label: t("DashboardPayments.recurring.details"),
      title: t("DashboardPayments.recurring.detailsStepTitle"),
    },
    {
      id: "review",
      label: t("DashboardPayments.counterparty.review"),
      title: t("DashboardPayments.recurring.reviewStepTitle"),
    },
  ] as const satisfies readonly { id: StepId; label: string; title: string }[];
  const schedulePresets = [
    {
      value: "24",
      label: t("DashboardPayments.recurring.everyDay"),
      description: t("DashboardPayments.recurring.collectDaily"),
    },
    {
      value: "168",
      label: t("DashboardPayments.recurring.everyWeek"),
      description: t("DashboardPayments.recurring.collectWeekly"),
    },
    {
      value: "720",
      label: t("DashboardPayments.recurring.everyThirtyDays"),
      description: t("DashboardPayments.recurring.collectMonthly"),
    },
    {
      value: "custom",
      label: t("DashboardPayments.recurring.custom"),
      description: t("DashboardPayments.recurring.customScheduleDescription"),
    },
  ] as const satisfies readonly { value: SchedulePreset; label: string; description: string }[];
  const router = useRouter();
  const [stepIndex, setStepIndex] = useState(0);
  const [counterpartyDialogOpen, setCounterpartyDialogOpen] = useState(false);
  const [destinationAccountDialogOpen, setDestinationAccountDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fields, setFields] = useState<RecurringPaymentCreateFields>({
    counterpartyId: "",
    counterpartyAccountId: "",
    walletId: "",
    token: "",
    amount: "",
    schedulePreset: "24",
    customPeriodHours: "",
    firstCollectionAt: "",
    metadataUri: "",
  });

  const { data: liveCounterpartiesResult, mutate: mutateCounterparties } = useSWR(
    PAYMENTS_ACTION_COUNTERPARTIES_KEY,
    fetchAllCounterparties,
    {
      fallbackData: counterpartiesResult,
    }
  );
  const liveCounterparties = liveCounterpartiesResult ?? counterpartiesResult;

  const { liveWallets: availableWallets, liveWalletsError } = usePaymentsActionWallets(
    wallets,
    walletsError
  );

  const {
    data: accounts,
    isLoading: accountsLoading,
    mutate: mutateAccounts,
  } = useSWR(
    fields.counterpartyId ? ["counterparty-accounts", fields.counterpartyId] : null,
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

  const selectedCounterparty =
    liveCounterparties.data.find((counterparty) => counterparty.id === fields.counterpartyId) ??
    null;
  const activeCounterpartiesResult = useMemo(
    () => ({
      ...liveCounterparties,
      data: liveCounterparties.data.filter((counterparty) => counterparty.status === "active"),
    }),
    [liveCounterparties]
  );
  const selectedAccount =
    cryptoAccounts.find((account) => account.id === fields.counterpartyAccountId) ?? null;
  const selectedWallet =
    availableWallets.find((wallet) => wallet.walletId === fields.walletId) ?? null;

  const assetOptions = useMemo<ComboboxOption[]>(
    () =>
      walletBalanceAssetOptions(selectedWallet, issuedTokenSymbolsByMint, t, {
        hideUnresolvedMints: true,
      }),
    [issuedTokenSymbolsByMint, selectedWallet, t]
  );
  const nonSolBalanceCount =
    selectedWallet?.balances?.filter((balance) => !isSolBalance(balance)).length ?? 0;

  const selectedAsset = assetOptions.find((asset) => asset.value === fields.token) ?? null;
  const selectedAssetBalance = useMemo<WalletBalance | null>(
    () =>
      selectedAsset
        ? (selectedWallet?.balances?.find((balance) => balance.mint === fields.token) ?? null)
        : null,
    [fields.token, selectedAsset, selectedWallet]
  );
  const periodHours = resolvePeriodHours(fields);
  const currentStep = createSteps[stepIndex];

  useEffect(() => {
    if (!fields.walletId) {
      return;
    }

    const nextToken = assetOptions.some((asset) => asset.value === fields.token)
      ? fields.token
      : (assetOptions[0]?.value ?? "");

    if (nextToken === fields.token) {
      return;
    }

    setFields((current) => ({ ...current, token: nextToken }));
  }, [assetOptions, fields.token, fields.walletId]);

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
      void preload(PAYMENTS_ACTION_WALLETS_KEY, () => fetchWallets({ includeBalances: true }));
      void preload(["counterparty-accounts", counterpartyId], () =>
        fetchCounterpartyAccounts(counterpartyId)
      );
    }
  };

  const selectWallet = (walletId: string) => {
    const wallet = availableWallets.find((entry) => entry.walletId === walletId) ?? null;
    const nextAssets = walletBalanceAssetOptions(wallet, issuedTokenSymbolsByMint, t, {
      hideUnresolvedMints: true,
    });
    setFields((current) => ({
      ...current,
      walletId,
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
    if (currentStep.id === "counterparty") {
      return Boolean(fields.counterpartyId);
    }
    if (currentStep.id === "destination") {
      return Boolean(fields.counterpartyAccountId && resolveAccountAddress(selectedAccount));
    }
    if (currentStep.id === "details") {
      return Boolean(
        fields.walletId &&
          fields.token &&
          selectedAssetBalance &&
          amountIsValid(fields.amount) &&
          periodHours &&
          firstCollectionAtIsValid(fields.firstCollectionAt) &&
          metadataUriIsValid(fields.metadataUri)
      );
    }
    return true;
  }, [currentStep.id, fields, periodHours, selectedAccount, selectedAssetBalance]);

  const reviewRows = [
    {
      label: t("DashboardPayments.counterpartyLabel"),
      value: selectedCounterparty?.displayName ?? t("DashboardPayments.recurring.notSelected"),
    },
    {
      label: t("DashboardPayments.recurring.destinationAccount"),
      value: selectedAccount
        ? (selectedAccount.label ?? shortenAddress(resolveAccountAddress(selectedAccount)))
        : t("DashboardPayments.recurring.notSelected"),
    },
    {
      label: t("DashboardPayments.recurring.fundingWallet"),
      value:
        selectedWallet?.label ??
        selectedWallet?.walletId ??
        t("DashboardPayments.recurring.notSelected"),
    },
    {
      label: t("DashboardPayments.recurring.amount"),
      value: `${fields.amount || "-"} ${selectedAsset?.label ?? ""}`.trim(),
    },
    {
      label: t("DashboardPayments.recurring.billingInterval"),
      value: resolveScheduleLabel(fields, t, schedulePresets),
    },
    {
      label: t("DashboardPayments.recurring.firstPayment"),
      value: fields.firstCollectionAt
        ? new Date(fields.firstCollectionAt).toLocaleString()
        : t("DashboardPayments.recurring.afterActivation"),
    },
    {
      label: t("DashboardPayments.recurring.metadata"),
      value: fields.metadataUri.trim() || t("DashboardPayments.recurring.notSet"),
    },
  ];

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
      const recurringPayment = await createRecurringPayment({
        sourceWalletId: fields.walletId,
        counterpartyId: fields.counterpartyId,
        counterpartyAccountId: fields.counterpartyAccountId,
        token: selectedAssetBalance.mint,
        amount: fields.amount.trim(),
        periodHours,
        ...(fields.firstCollectionAt
          ? { firstCollectionAt: new Date(fields.firstCollectionAt).toISOString() }
          : {}),
        ...(fields.metadataUri.trim() ? { metadataUri: fields.metadataUri.trim() } : {}),
      });
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
    if (currentStep.id === "review") {
      await submitRecurringPayment();
      return;
    }
    setStepIndex((current) => current + 1);
  };

  const handleSecondary = () => {
    if (submitting) {
      return;
    }
    if (stepIndex === 0) {
      router.push("/dashboard/payments/recurring");
      return;
    }
    setStepIndex((current) => Math.max(0, current - 1));
  };

  return (
    <RampWizardShell
      steps={createSteps}
      stepIndex={stepIndex}
      primaryDisabled={!canProceed || submitting}
      primaryLabel={
        currentStep.id === "review"
          ? t("DashboardPayments.recurring.createPayment")
          : t("DashboardPayments.counterparty.next")
      }
      secondaryLabel={
        stepIndex === 0
          ? t("DashboardPayments.counterparty.cancel")
          : t("DashboardPayments.previous")
      }
      walletsError={liveWalletsError}
      onPrimary={handlePrimary}
      onSecondary={handleSecondary}
      counterpartyDialogOpen={counterpartyDialogOpen}
      setCounterpartyDialogOpen={setCounterpartyDialogOpen}
      onCounterpartyCreated={handleCounterpartyCreated}
      secondaryDisabled={submitting}
    >
      {formError ? (
        <div
          role="alert"
          className="rounded-2xl border border-status-error-border bg-status-error-bg px-4 py-3 text-sm text-status-error-text"
        >
          {formError}
        </div>
      ) : null}

      {currentStep.id === "counterparty" ? (
        <CounterpartyPicker
          mode="send"
          counterpartiesResult={activeCounterpartiesResult}
          value={fields.counterpartyId || null}
          onChange={selectCounterparty}
          onAddClick={() => setCounterpartyDialogOpen(true)}
        />
      ) : null}

      {currentStep.id === "destination" ? (
        <div className="space-y-3">
          <Combobox
            label={t("DashboardPayments.recurring.destinationAccount")}
            value={fields.counterpartyAccountId || null}
            onChange={(value) => setField("counterpartyAccountId", value)}
            options={cryptoAccounts.map((account) => {
              const address = resolveAccountAddress(account);
              return {
                value: account.id,
                label: account.label ?? shortenAddress(address),
                description: shortenAddress(address),
              };
            })}
            placeholder={
              accountsLoading
                ? t("DashboardPayments.recurring.loadingAccounts")
                : cryptoAccounts.length === 0
                  ? t("DashboardPayments.recurring.noSolanaAccounts")
                  : t("DashboardPayments.recurring.selectDestinationAccount")
            }
            searchPlaceholder={t("DashboardPayments.recurring.searchAccounts")}
            icon={<WalletIcon />}
            isLoading={accountsLoading}
            disabled={accountsLoading || cryptoAccounts.length === 0}
          />
          {!accountsLoading && cryptoAccounts.length === 0 ? (
            <FieldHint tone="error">
              {t("DashboardPayments.recurring.needsCryptoAccount")}
            </FieldHint>
          ) : null}
          {fields.counterpartyId && !accountsLoading ? (
            <button
              type="button"
              onClick={() => setDestinationAccountDialogOpen(true)}
              className="flex w-full items-center gap-3 rounded-2xl border border-dashed border-border-medium px-4 py-4 text-left transition-colors hover:bg-border-extra-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/50 dark:focus-visible:ring-white/50"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-border-extra-light text-text-extra-high">
                <PlusIcon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-text-extra-high">
                  {t("DashboardPayments.recurring.addSolanaAddress")}
                </span>
                <span className="block text-sm text-text-low">
                  {cryptoAccounts.length === 0
                    ? t("DashboardPayments.recurring.noDestinationWallet", {
                        name:
                          selectedCounterparty?.displayName ??
                          t("DashboardPayments.counterpartyLabel"),
                      })
                    : t("DashboardPayments.recurring.attachDestinationWallet")}
                </span>
              </span>
            </button>
          ) : null}
          {fields.counterpartyId ? (
            <AddExternalAccountDialog
              isOpen={destinationAccountDialogOpen}
              counterpartyId={fields.counterpartyId}
              onAdded={handleDestinationAccountAdded}
              onClose={() => setDestinationAccountDialogOpen(false)}
            />
          ) : null}
        </div>
      ) : null}

      {currentStep.id === "details" ? (
        <div className="space-y-5">
          <Combobox
            label={t("DashboardPayments.recurring.fundingWallet")}
            value={fields.walletId || null}
            onChange={selectWallet}
            options={availableWallets.map((wallet) => ({
              value: wallet.walletId,
              label: wallet.label ?? wallet.walletId,
              description: shortenAddress(wallet.publicKey),
            }))}
            placeholder={t("DashboardPayments.recurring.selectFundingWallet")}
            searchPlaceholder={t("DashboardPayments.recurring.searchWallets")}
            icon={<WalletIcon />}
            disabled={availableWallets.length === 0}
          />

          <Combobox
            label={t("DashboardPayments.recurring.asset")}
            value={fields.token || null}
            onChange={(value) => setField("token", value)}
            options={assetOptions}
            placeholder={
              fields.walletId
                ? assetOptions.length === 0
                  ? t("DashboardPayments.recurring.noTokenBalances")
                  : t("DashboardPayments.recurring.selectAsset")
                : t("DashboardPayments.recurring.selectWalletFirst")
            }
            searchPlaceholder={t("DashboardPayments.recurring.searchAssets")}
            icon={<CreditCardIcon />}
            disabled={!fields.walletId || assetOptions.length === 0}
          />
          {fields.walletId && assetOptions.length === 0 ? (
            <FieldHint tone="error">
              {nonSolBalanceCount > 0
                ? t("DashboardPayments.recurring.unresolvedTokenBalances")
                : t("DashboardPayments.recurring.nativeSolUnsupported")}
            </FieldHint>
          ) : null}

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="recurring-payment-amount">
                {t("DashboardPayments.recurring.amount")}
              </Label>
              <Input
                id="recurring-payment-amount"
                inputMode="decimal"
                value={fields.amount}
                onChange={(event) => setField("amount", event.currentTarget.value)}
                placeholder="0.00"
              />
              {fields.amount && !amountIsValid(fields.amount) ? (
                <FieldHint tone="error">{t("DashboardPayments.recurring.invalidAmount")}</FieldHint>
              ) : null}
            </div>

            <Combobox
              label={t("DashboardPayments.recurring.billingInterval")}
              value={fields.schedulePreset}
              onChange={(value) => setField("schedulePreset", value as SchedulePreset)}
              options={schedulePresets}
              searchable={false}
              icon={<RepeatIcon />}
              size="lg"
            />
          </div>

          {fields.schedulePreset === "custom" ? (
            <div className="space-y-2">
              <Label htmlFor="recurring-payment-period-hours">
                {t("DashboardPayments.recurring.intervalHours")}
              </Label>
              <Input
                id="recurring-payment-period-hours"
                inputMode="numeric"
                value={fields.customPeriodHours}
                onChange={(event) => setField("customPeriodHours", event.currentTarget.value)}
                placeholder="24"
              />
              {fields.customPeriodHours && !resolvePeriodHours(fields) ? (
                <FieldHint tone="error">
                  {t("DashboardPayments.recurring.invalidInterval")}
                </FieldHint>
              ) : null}
            </div>
          ) : null}

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="recurring-payment-first-collection">
                {t("DashboardPayments.recurring.firstPayment")}
              </Label>
              <Input
                id="recurring-payment-first-collection"
                type="datetime-local"
                value={fields.firstCollectionAt}
                onChange={(event) => setField("firstCollectionAt", event.currentTarget.value)}
              />
              {fields.firstCollectionAt && !firstCollectionAtIsValid(fields.firstCollectionAt) ? (
                <FieldHint tone="error">
                  {t("DashboardPayments.recurring.invalidFirstPayment")}
                </FieldHint>
              ) : (
                <FieldHint>{t("DashboardPayments.recurring.startAfterActivation")}</FieldHint>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="recurring-payment-metadata">
                {t("DashboardPayments.recurring.metadataUrl")}
              </Label>
              <Input
                id="recurring-payment-metadata"
                value={fields.metadataUri}
                onChange={(event) => setField("metadataUri", event.currentTarget.value)}
                placeholder={t("DashboardPayments.recurring.metadataUrlPlaceholder")}
              />
              {fields.metadataUri && !metadataUriIsValid(fields.metadataUri) ? (
                <FieldHint tone="error">
                  {t("DashboardPayments.recurring.invalidMetadataUrl")}
                </FieldHint>
              ) : (
                <FieldHint>{t("DashboardPayments.recurring.optional")}</FieldHint>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {currentStep.id === "review" ? (
        <div className="space-y-5">
          <ReviewSummaryCard rows={reviewRows} />
          <div className="rounded-2xl border border-border-light bg-white px-4 py-3 text-sm text-text-medium">
            {t("DashboardPayments.recurring.pendingRecordDescription")}
          </div>
        </div>
      ) : null}
    </RampWizardShell>
  );
}
