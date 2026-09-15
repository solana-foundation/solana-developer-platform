"use client";

import { compareDecimalAmounts } from "@sdp/payments/decimal";
import type { PaymentsDashboardWallet } from "@sdp/types";
import {
  CheckCircle2Icon,
  ExternalLinkIcon,
  PlusIcon,
  StickyNoteIcon,
  UserRoundIcon,
  WalletIcon,
} from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { AddExternalAccountDialog } from "@/app/dashboard/payments/counterparty/add-external-account-dialog";
import { shortenAddress } from "@/app/dashboard/payments/payments-overview.utils";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/i18n/provider";
import { explorerTxUrl } from "@/lib/explorer";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
import type { OnchainSendWizard } from "../hooks/use-onchain-send-wizard";
import { walletComboboxOptions } from "../wallet-options";
import { AmountBalanceReadout } from "./amount-balance-readout";
import { CounterpartyAccountSelector } from "./counterparty-account-selector";

interface StepProps {
  wizard: OnchainSendWizard;
  counterpartyName: string;
}

function NoAssetsHint({ walletId, assetCount }: { walletId: string; assetCount: number }) {
  const t = useTranslations();
  if (walletId === "" || assetCount > 0) {
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

function sourceWalletName(wallet: PaymentsDashboardWallet | null): string {
  if (wallet === null) {
    return "—";
  }
  if (wallet.label === null) {
    return wallet.walletId;
  }
  return wallet.label;
}

function DestinationStep({ wizard, counterpartyName }: StepProps) {
  const t = useTranslations();
  const {
    cryptoAccounts,
    accountsLoading,
    counterpartyId,
    fields,
    setField,
    addAccountOpen,
    setAddAccountOpen,
    handleAccountAdded,
  } = wizard;
  const counterpartyLabel =
    counterpartyName === ""
      ? t("DashboardPayments.onchainSend.thisCounterparty")
      : counterpartyName;
  return (
    <div className="space-y-3">
      <CounterpartyAccountSelector
        accounts={cryptoAccounts}
        value={fields.accountId === "" ? null : fields.accountId}
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
                  counterparty: counterpartyLabel,
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

function DetailsStep({ wizard }: StepProps) {
  const t = useTranslations();
  const {
    liveWallets,
    walletsLoading,
    assetOptions,
    availableAmount,
    selectedAsset,
    exceedsBalance,
    fields,
    setField,
    selectWallet,
  } = wizard;
  const walletOptions = useMemo(() => walletComboboxOptions(liveWallets), [liveWallets]);
  const assetSelectOptions = useMemo(
    () => assetOptions.map((asset) => ({ value: asset.value, label: asset.label })),
    [assetOptions]
  );
  return (
    <div className="space-y-4">
      <Combobox
        label={t("DashboardPayments.onchainSend.sourceWallet")}
        value={fields.walletId === "" ? null : fields.walletId}
        onChange={selectWallet}
        options={walletOptions}
        placeholder={t("DashboardPayments.onchainSend.selectSourceWallet")}
        searchPlaceholder={t("DashboardPayments.onchainSend.searchWallets")}
        icon={<WalletIcon className="size-5 shrink-0 text-tertiary" />}
        isLoading={walletsLoading}
      />
      <div className="grid items-end gap-4 sm:grid-cols-[minmax(0,1fr)_160px]">
        <div className="flex flex-col gap-2">
          <Label className="text-tertiary" htmlFor="onchain-send-amount">
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
            action={
              availableAmount === null ? undefined : (
                <AmountBalanceReadout
                  available={availableAmount}
                  assetLabel={selectedAsset === null ? fields.asset : selectedAsset.label}
                  exceeds={exceedsBalance}
                  onMax={
                    compareDecimalAmounts(availableAmount, "0") > 0
                      ? () => setField("amount", availableAmount)
                      : undefined
                  }
                />
              )
            }
          />
        </div>
        <Combobox
          label={t("DashboardPayments.onchainSend.asset")}
          value={fields.asset === "" ? null : fields.asset}
          onChange={(value) => setField("asset", value)}
          options={assetSelectOptions}
          placeholder={t("DashboardPayments.onchainSend.selectAsset")}
          searchable={false}
          disabled={fields.walletId === "" || assetSelectOptions.length === 0}
        />
      </div>
      <NoAssetsHint walletId={fields.walletId} assetCount={assetSelectOptions.length} />
      <div className="flex flex-col gap-2">
        <Label className="text-tertiary" htmlFor="onchain-send-memo">
          {t("DashboardPayments.onchainSend.memoOptional")}
        </Label>
        <Input
          id="onchain-send-memo"
          value={fields.memo}
          onChange={(event) => setField("memo", event.currentTarget.value)}
          placeholder={t("DashboardPayments.onchainSend.memoPlaceholder")}
          size="xl"
        />
      </div>
    </div>
  );
}

function ReviewSummary({ wizard, counterpartyName }: StepProps) {
  const t = useTranslations();
  const { selectedWallet, destinationAddress, selectedAsset, fields } = wizard;
  const memo = fields.memo.trim();
  return (
    <>
      <div className="flex flex-col items-center gap-0.5 border-b border-border-default pb-4">
        <p className="text-3xl font-semibold tracking-tight text-primary">
          {fields.amount === "" ? "0" : fields.amount}{" "}
          {selectedAsset === null ? fields.asset : selectedAsset.label}
        </p>
        <p className="text-sm text-tertiary">
          {t("DashboardPayments.onchainSend.toCounterparty", {
            counterparty:
              counterpartyName === ""
                ? t("DashboardPayments.onchainSend.counterparty")
                : counterpartyName,
          })}
        </p>
      </div>
      <div className="divide-y divide-border-default">
        <DetailRow
          icon={<UserRoundIcon className="size-3.5" />}
          label={t("DashboardPayments.onchainSend.to")}
          value={counterpartyName === "" ? "—" : counterpartyName}
        />
        <DetailRow
          icon={<WalletIcon className="size-3.5" />}
          label={t("DashboardPayments.onchainSend.destination")}
          value={
            <span className="font-mono text-xs">
              {destinationAddress === null ? "—" : shortenAddress(destinationAddress)}
            </span>
          }
        />
        <DetailRow
          icon={<WalletIcon className="size-3.5" />}
          label={t("DashboardPayments.onchainSend.sourceWallet")}
          value={sourceWalletName(selectedWallet)}
        />
        {memo === "" ? null : (
          <DetailRow
            icon={<StickyNoteIcon className="size-3.5" />}
            label={t("DashboardPayments.onchainSend.memo")}
            value={memo}
          />
        )}
      </div>
    </>
  );
}

function ReviewStep({ wizard, counterpartyName }: StepProps) {
  const t = useTranslations();
  const cluster = useSolanaCluster();
  const { transferResult } = wizard;
  if (transferResult === null) {
    return (
      <section className="space-y-4 rounded-2xl bg-fill-subtle p-5">
        <ReviewSummary wizard={wizard} counterpartyName={counterpartyName} />
      </section>
    );
  }
  const signature = transferResult.signature;
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
          {signature === null
            ? t("DashboardPayments.onchainSend.transferStatus", { status: transferResult.status })
            : t("DashboardPayments.onchainSend.transferSuccess")}
        </p>
      </div>
      <section className="w-full space-y-4 rounded-2xl bg-fill-subtle p-5">
        <ReviewSummary wizard={wizard} counterpartyName={counterpartyName} />
      </section>
      {signature === null ? null : (
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          iconLeft={<ExternalLinkIcon />}
          onClick={() => window.open(explorerTxUrl(signature, cluster), "_blank")}
        >
          {t("DashboardPayments.onchainSend.viewOnExplorer")}
        </Button>
      )}
    </div>
  );
}

export function OnchainSendStepContent({ wizard, counterpartyName }: StepProps) {
  switch (wizard.currentStepId) {
    case "DESTINATION":
      return <DestinationStep wizard={wizard} counterpartyName={counterpartyName} />;
    case "DETAILS":
      return <DetailsStep wizard={wizard} counterpartyName={counterpartyName} />;
    case "REVIEW":
      return <ReviewStep wizard={wizard} counterpartyName={counterpartyName} />;
  }
}
