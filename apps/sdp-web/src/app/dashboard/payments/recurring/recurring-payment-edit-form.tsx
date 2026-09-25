"use client";

import {
  type CounterpartyAccount,
  PAYMENT_RECURRING_PAYMENT_SCHEDULE_PRESETS,
  type PaymentRecurringPayment,
  type UpdatePaymentRecurringPaymentRequest,
} from "@sdp/types";
import { Loader2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/i18n/provider";
import { shortenAddress } from "../payments-overview.utils";
import { getRecurringPaymentDetailState } from "./recurring-payment-detail-state";
import { updateRecurringPayment } from "./recurring-payments.data";
import {
  accountAddress,
  accountLabel,
  amountIsValid,
  getSchedulePresets,
  parsePeriodHours,
  type RecurringPaymentWalletView,
  type SchedulePreset,
  schedulePresetForPeriodHours,
  type Translate,
  walletLabel,
} from "./recurring-payments-shared";
import { recurringPaymentAssetOptions } from "./use-recurring-payment-create";

interface EditFields {
  amount: string;
  token: string;
  sourceCustodyWalletId: string;
  counterpartyAccountId: string;
  schedulePreset: SchedulePreset;
  customPeriodHours: string;
}

/**
 * What the form changed, as the update request carries it, or the reason it cannot be sent:
 * an invalid field, or nothing changed.
 */
function editUpdates(
  fields: EditFields,
  recurringPayment: PaymentRecurringPayment & { sourceCustodyWalletId: string },
  t: Translate
): { updates: UpdatePaymentRecurringPaymentRequest } | { error: string } {
  const amount = fields.amount.trim();
  if (!amountIsValid(amount)) return { error: t("DashboardPayments.recurring.invalidAmount") };
  const periodHours = parsePeriodHours(fields.schedulePreset, fields.customPeriodHours);
  if (!periodHours) return { error: t("DashboardPayments.recurring.invalidInterval") };
  if (!fields.token) return { error: t("DashboardPayments.recurring.selectCurrency") };
  if (!fields.sourceCustodyWalletId) {
    return { error: t("DashboardPayments.recurring.selectFundingWallet") };
  }
  if (!fields.counterpartyAccountId) {
    return { error: t("DashboardPayments.recurring.selectReceivingWallet") };
  }

  const updates: UpdatePaymentRecurringPaymentRequest = {};
  if (amount !== recurringPayment.amount) updates.amount = amount;
  if (fields.token !== recurringPayment.token) updates.token = fields.token;
  if (periodHours !== recurringPayment.periodHours) updates.periodHours = periodHours;
  if (fields.sourceCustodyWalletId !== recurringPayment.sourceCustodyWalletId) {
    updates.sourceCustodyWalletId = fields.sourceCustodyWalletId;
  }
  if (fields.counterpartyAccountId !== recurringPayment.counterpartyAccountId) {
    updates.counterpartyAccountId = fields.counterpartyAccountId;
  }
  return Object.keys(updates).length === 0
    ? { error: t("DashboardPayments.recurring.noChangesToSave") }
    : { updates };
}

/**
 * The schedule's plan edited in place, as the design swaps it for the rows: amount and token
 * side by side, the funding wallet, the address it pays into, and how often it repeats, then
 * Cancel and Save changes. Editing an active schedule replaces its subscription on chain, so a
 * wallet that cannot sign is listed but not on offer.
 */
export function RecurringPaymentEditForm({
  recurringPayment,
  wallet,
  liveWallets,
  counterpartyAccounts,
  hasPendingAction,
  saving,
  onSavingChange,
  onClose,
}: {
  recurringPayment: PaymentRecurringPayment & { sourceCustodyWalletId: string };
  wallet: RecurringPaymentWalletView | null;
  liveWallets: RecurringPaymentWalletView[];
  counterpartyAccounts: CounterpartyAccount[];
  hasPendingAction: boolean;
  saving: boolean;
  onSavingChange: (saving: boolean) => void;
  onClose: () => void;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [fields, setFields] = useState<EditFields>(() => ({
    amount: recurringPayment.amount,
    token: recurringPayment.token,
    sourceCustodyWalletId: recurringPayment.sourceCustodyWalletId,
    counterpartyAccountId: recurringPayment.counterpartyAccountId,
    schedulePreset: schedulePresetForPeriodHours(recurringPayment.periodHours),
    customPeriodHours: String(recurringPayment.periodHours),
  }));
  const [validationError, setValidationError] = useState<string | null>(null);
  const setField = <K extends keyof EditFields>(key: K, value: EditFields[K]) => {
    setFields((current) => ({ ...current, [key]: value }));
    setValidationError(null);
  };
  const selectedWallet = liveWallets.find((entry) => entry.id === fields.sourceCustodyWalletId);
  const { editWalletUnavailable, saveDisabled } = getRecurringPaymentDetailState({
    sourceCustodyWalletId: recurringPayment.sourceCustodyWalletId,
    status: recurringPayment.status,
    hasPendingAction,
    savingPayment: saving,
    sourceWallet: liveWallets.find((entry) => entry.id === recurringPayment.sourceCustodyWalletId),
    selectedWallet,
    selectedCustodyWalletId: fields.sourceCustodyWalletId,
  });
  const assetOptions = recurringPaymentAssetOptions(selectedWallet ?? wallet, {}, t);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saveDisabled) return;
    const result = editUpdates(fields, recurringPayment, t);
    if ("error" in result) {
      setValidationError(result.error);
      return;
    }
    onSavingChange(true);
    const toastId = toast.loading(t("DashboardPayments.recurring.updatingPayment"), {
      position: "bottom-right",
    });
    try {
      await updateRecurringPayment(recurringPayment.id, result.updates, undefined, t);
      toast.success(t("DashboardPayments.recurring.paymentUpdated"), {
        id: toastId,
        position: "bottom-right",
      });
      onClose();
      router.refresh();
    } catch (error) {
      toast.error(t("DashboardPayments.recurring.paymentUpdateFailed"), {
        id: toastId,
        description:
          error instanceof Error
            ? error.message
            : t("DashboardPayments.recurring.paymentUpdateFailed"),
        position: "bottom-right",
      });
    } finally {
      onSavingChange(false);
    }
  };

  return (
    <form className="flex flex-col gap-6" onSubmit={(event) => void submit(event)}>
      <div className="grid gap-6 md:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="schedule-edit-amount">{t("DashboardPayments.recurring.amount")}</Label>
          <Input
            id="schedule-edit-amount"
            inputMode="decimal"
            autoComplete="off"
            className="tabular-nums"
            value={fields.amount}
            disabled={saving}
            onChange={(event) => setField("amount", event.currentTarget.value)}
            placeholder="0.00"
            size="xl"
          />
        </div>
        <Combobox
          label={t("DashboardPayments.payForm.token")}
          value={fields.token}
          onChange={(value) => setField("token", value)}
          options={assetOptions}
          placeholder={
            assetOptions.length === 0
              ? t("DashboardPayments.recurring.noTokenBalances")
              : t("DashboardPayments.recurring.selectCurrency")
          }
          searchable={false}
          disabled={saving || assetOptions.length === 0}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Combobox
          label={t("DashboardPayments.recurring.fundingWallet")}
          value={fields.sourceCustodyWalletId}
          onChange={(value) => setField("sourceCustodyWalletId", value)}
          options={liveWallets.map((entry) => ({
            value: entry.id,
            label: walletLabel(entry, entry.walletId),
            description: shortenAddress(entry.publicKey),
            ...(entry.isRuntimeExecutionAllowed !== true
              ? {
                  badge: t("DashboardPayments.restricted"),
                  badgeVariant: "warning" as const,
                  // A pending schedule may still point at it; an active one would have to
                  // sign with it, so the picker does not let the user select it.
                  disabled: recurringPayment.status === "active",
                }
              : {}),
          }))}
          placeholder={t("DashboardPayments.recurring.selectFundingWallet")}
          searchPlaceholder={t("DashboardPayments.recurring.searchWallets")}
          disabled={saving || liveWallets.length === 0}
        />
        <p role="status" hidden={!editWalletUnavailable} className="text-meta text-warning">
          {t("DashboardPayments.signingUnavailable")}
        </p>
      </div>
      <Combobox
        label={t("DashboardPayments.recurring.receivingWallet")}
        value={fields.counterpartyAccountId}
        onChange={(value) => setField("counterpartyAccountId", value)}
        options={counterpartyAccounts.map((account) => ({
          value: account.id,
          label: accountLabel(account, account.id),
          description: shortenAddress(accountAddress(account)),
        }))}
        placeholder={t("DashboardPayments.recurring.selectReceivingWallet")}
        searchPlaceholder={t("DashboardPayments.recurring.searchAccounts")}
        disabled={saving || counterpartyAccounts.length === 0}
      />
      <div className="grid gap-6 md:grid-cols-2">
        <Combobox
          label={t("DashboardPayments.recurring.repeats")}
          value={fields.schedulePreset}
          onChange={(value) => {
            const parsed = z.enum(PAYMENT_RECURRING_PAYMENT_SCHEDULE_PRESETS).safeParse(value);
            if (parsed.success) setField("schedulePreset", parsed.data);
          }}
          options={getSchedulePresets(t)}
          searchable={false}
          disabled={saving}
        />
        {fields.schedulePreset === "custom" ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="schedule-edit-hours">
              {t("DashboardPayments.recurring.intervalHours")}
            </Label>
            <Input
              id="schedule-edit-hours"
              inputMode="numeric"
              autoComplete="off"
              className="tabular-nums"
              value={fields.customPeriodHours}
              disabled={saving}
              onChange={(event) => setField("customPeriodHours", event.currentTarget.value)}
              placeholder="24"
              size="xl"
            />
          </div>
        ) : null}
      </div>
      {validationError ? <p className="text-meta text-error">{validationError}</p> : null}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={onClose}>
          {t("DashboardPayments.recurring.cancel")}
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={saveDisabled}
          iconLeft={saving ? <Loader2Icon className="size-4 shrink-0 animate-spin" /> : undefined}
        >
          {t("DashboardPayments.recurring.saveChanges")}
        </Button>
      </div>
    </form>
  );
}
