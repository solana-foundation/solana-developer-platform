"use client";

import {
  CheckCircle2Icon,
  ExternalLink,
  PlusIcon,
  StickyNoteIcon,
  UserRoundIcon,
  WalletIcon,
} from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { AddExternalAccountDialog } from "@/app/dashboard/payments/counterparty/add-external-account-dialog";
import { shortenAddress } from "@/app/dashboard/payments/payments-overview.utils";
import { getDevnetExplorerUrl } from "@/app/dashboard/payments/payments-workspace.data";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/i18n/provider";
import type { OnchainSendWizard } from "../hooks/use-onchain-send-wizard";
import { walletComboboxOptions } from "../wallet-options";
import { AmountBalanceReadout } from "./amount-balance-readout";
import { CounterpartyAccountSelector } from "./counterparty-account-selector";

function NoAssetsHint({ walletId, assetCount }: { walletId: string; assetCount: number }) {
  const t = useTranslations();
  if (!walletId || assetCount > 0) {
    return null;
  }
  return <p className="text-sm text-error">{t("DashboardPayments.onchainSend.noAssets")}</p>;
}

function DetailRow({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <span className="flex items-center gap-2.5 text-sm text-tertiary">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-raised text-secondary">
          {icon}
        </span>
        {label}
      </span>
      <div className="min-w-0 truncate text-right text-sm font-medium text-primary">{value}</div>
    </div>
  );
}

export function OnchainSendStepContent({
  wizard,
  counterpartyName,
}: {
  wizard: OnchainSendWizard;
  counterpartyName: string;
}) {
  const t = useTranslations();
  const {
    currentStepId,
    cryptoAccounts,
    accountsLoading,
    liveWallets,
    walletsLoading,
    selectedWallet,
    destinationAddress,
    assetOptions,
    availableAmount,
    selectedAsset,
    selectedAssetBalance,
    exceedsBalance,
    counterpartyId,
    fields,
    setField,
    selectWallet,
    addAccountOpen,
    setAddAccountOpen,
    handleAccountAdded,
    transferResult,
  } = wizard;

  const walletOptions = useMemo(() => walletComboboxOptions(liveWallets), [liveWallets]);
  const assetSelectOptions = useMemo(
    () => assetOptions.map((asset) => ({ value: asset.value, label: asset.label })),
    [assetOptions]
  );

  if (currentStepId === "DESTINATION") {
    return (
      <div className="space-y-3">
        <CounterpartyAccountSelector
          accounts={cryptoAccounts}
          value={fields.accountId || null}
          onChange={(id) => setField("accountId", id)}
          isLoading={accountsLoading}
        />
        <button
          type="button"
          onClick={() => setAddAccountOpen(true)}
          className="flex w-full items-center gap-3 rounded-2xl border border-dashed border-border-strong px-4 py-4 text-left transition-colors hover:bg-fill-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-fill-subtle text-primary">
            <PlusIcon className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-primary">
              {t("DashboardPayments.onchainSend.addSolanaAddress")}
            </span>
            <span className="block text-sm text-tertiary">
              {cryptoAccounts.length === 0
                ? t("DashboardPayments.onchainSend.counterpartyNoAddress", {
                    counterparty:
                      counterpartyName || t("DashboardPayments.onchainSend.thisCounterparty"),
                  })
                : t("DashboardPayments.onchainSend.attachDestination")}
            </span>
          </span>
        </button>
        <AddExternalAccountDialog
          isOpen={addAccountOpen}
          counterpartyId={counterpartyId}
          onAdded={handleAccountAdded}
          onClose={() => setAddAccountOpen(false)}
        />
      </div>
    );
  }

  if (currentStepId === "DETAILS") {
    return (
      <div className="space-y-4">
        <Combobox
          label={t("DashboardPayments.onchainSend.sourceWallet")}
          value={fields.walletId || null}
          onChange={selectWallet}
          options={walletOptions}
          placeholder={t("DashboardPayments.onchainSend.selectSourceWallet")}
          searchPlaceholder={t("DashboardPayments.onchainSend.searchWallets")}
          icon={<WalletIcon className="size-5 shrink-0 text-tertiary" />}
          isLoading={walletsLoading}
        />
        <div className="grid items-end gap-4 sm:grid-cols-[minmax(0,1fr)_160px]">
          <div className="flex flex-col gap-2">
            <Label className="text-sm font-medium text-tertiary" htmlFor="onchain-send-amount">
              {t("DashboardPayments.onchainSend.amount")}
            </Label>
            <Input
              id="onchain-send-amount"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={fields.amount}
              onChange={(event) => setField("amount", event.currentTarget.value)}
              placeholder="1.0"
              size="xl"
              className="h-[var(--input-height-xl)] shadow-none ring-0 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [&>span:first-child]:h-[var(--input-height-xl)] [&>span:first-child]:border-0 [&>span:first-child]:bg-fill-subtle"
              action={
                availableAmount !== null ? (
                  <AmountBalanceReadout
                    available={selectedAssetBalance ? selectedAssetBalance.uiAmount : "0"}
                    assetLabel={selectedAsset?.label ?? fields.asset}
                    exceeds={exceedsBalance}
                    onMax={
                      selectedAssetBalance && availableAmount > 0
                        ? () => setField("amount", String(selectedAssetBalance.uiAmount))
                        : undefined
                    }
                  />
                ) : undefined
              }
            />
          </div>
          <Combobox
            label={t("DashboardPayments.onchainSend.asset")}
            value={fields.asset || null}
            onChange={(value) => setField("asset", value)}
            options={assetSelectOptions}
            placeholder={t("DashboardPayments.onchainSend.selectAsset")}
            searchable={false}
            disabled={!fields.walletId || assetSelectOptions.length === 0}
          />
        </div>
        <NoAssetsHint walletId={fields.walletId} assetCount={assetSelectOptions.length} />
        <div className="flex flex-col gap-2">
          <Label className="text-sm font-medium text-tertiary" htmlFor="onchain-send-memo">
            {t("DashboardPayments.onchainSend.memoOptional")}
          </Label>
          <Input
            id="onchain-send-memo"
            value={fields.memo}
            onChange={(event) => setField("memo", event.currentTarget.value)}
            placeholder={t("DashboardPayments.onchainSend.memoPlaceholder")}
            size="xl"
            className="shadow-none ring-0 [&>span:first-child]:border-0 [&>span:first-child]:bg-fill-subtle"
          />
        </div>
      </div>
    );
  }

  const detailRows = (
    <div className="divide-y divide-border-default">
      <DetailRow
        icon={<UserRoundIcon className="size-3.5" />}
        label={t("DashboardPayments.onchainSend.to")}
        value={counterpartyName || "—"}
      />
      <DetailRow
        icon={<WalletIcon className="size-3.5" />}
        label={t("DashboardPayments.onchainSend.destination")}
        value={<span className="font-mono text-xs">{shortenAddress(destinationAddress)}</span>}
      />
      <DetailRow
        icon={<WalletIcon className="size-3.5" />}
        label={t("DashboardPayments.onchainSend.sourceWallet")}
        value={selectedWallet?.label ?? selectedWallet?.walletId ?? "—"}
      />
      {fields.memo.trim() ? (
        <DetailRow
          icon={<StickyNoteIcon className="size-3.5" />}
          label={t("DashboardPayments.onchainSend.memo")}
          value={fields.memo.trim()}
        />
      ) : null}
    </div>
  );

  const amountHero = (
    <div className="flex flex-col items-center gap-0.5 border-b border-border-default pb-4">
      <p className="text-3xl font-semibold tracking-tight text-primary">
        {fields.amount || "0"} {selectedAsset?.label ?? fields.asset}
      </p>
      <p className="text-sm text-tertiary">
        {t("DashboardPayments.onchainSend.toCounterparty", {
          counterparty: counterpartyName || t("DashboardPayments.onchainSend.counterparty"),
        })}
      </p>
    </div>
  );

  if (transferResult) {
    return (
      <div className="flex flex-col items-center gap-6">
        <div className="flex size-16 items-center justify-center rounded-full bg-success-bg text-success">
          <CheckCircle2Icon className="size-8" />
        </div>
        <div className="space-y-1 text-center">
          <p className="text-2xl font-medium tracking-tight text-primary">
            {t("DashboardPayments.onchainSend.transferSubmitted")}
          </p>
          <p className="text-sm text-tertiary">
            {transferResult.signature
              ? t("DashboardPayments.onchainSend.transferSuccess")
              : t("DashboardPayments.onchainSend.transferStatus", {
                  status: transferResult.status,
                })}
          </p>
        </div>
        <section className="w-full space-y-4 rounded-2xl bg-fill-subtle p-5">
          {amountHero}
          {detailRows}
        </section>
        {transferResult.signature ? (
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            iconLeft={<ExternalLink />}
            onClick={() =>
              window.open(getDevnetExplorerUrl(transferResult.signature ?? ""), "_blank")
            }
          >
            {t("DashboardPayments.onchainSend.viewOnExplorer")}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <section className="space-y-4 rounded-2xl bg-fill-subtle p-5">
      {amountHero}
      {detailRows}
    </section>
  );
}
