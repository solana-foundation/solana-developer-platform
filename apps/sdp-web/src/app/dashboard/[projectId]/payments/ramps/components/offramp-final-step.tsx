"use client";

import { getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import type { PaymentTransferSummary, RampCryptoDeposit } from "@sdp/types/payments";
import { Button } from "@sdp/ui/button";
import { Modal } from "@sdp/ui/modal";
import { RotateCcwIcon, SendIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { shortenAddress } from "@/app/dashboard/[projectId]/payments/payments-overview.utils";
import { formatDecimalAmount } from "@/app/dashboard/[projectId]/payments/payments-presentation";
import type {
  OfframpFinalStepWizard,
  OfframpFooterAction,
} from "@/app/dashboard/[projectId]/payments/ramps/offramp-footer-action";
import { walletPickerLabel } from "@/app/dashboard/[projectId]/payments/ramps/wallet-options";
import { useLocale, useTranslations } from "@/i18n/provider";
import { transactionHref } from "@/lib/payments-routes";
import { getRampProviderLabel } from "@/lib/ramps";
import { useCopy } from "@/lib/use-copy";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { InstructionActionButton } from "./instruction-action-button";
import { RampStatusPanel } from "./ramp-status-panel";

/**
 * Sending moves money from the wallet to an address only the provider named,
 * so the address and amount are on screen before the click that signs.
 */
export function SendDepositDialog({
  open,
  provider,
  depositTarget,
  token,
  walletLabel,
  onClose,
  onSend,
}: {
  open: boolean;
  provider: PaymentTransferSummary["provider"];
  depositTarget: RampCryptoDeposit;
  token: string;
  walletLabel: string | null;
  onClose: () => void;
  onSend: () => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const { copy, copied } = useCopy(1200);
  const providerLabel = provider
    ? getRampProviderLabel(provider)
    : t("DashboardPayments.ramps.phase.providerFallback");
  const amount = `${formatDecimalAmount(depositTarget.amount, locale)} ${token}`;
  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      ariaLabel={t("DashboardPayments.ramps.sendConfirm.title", { amount })}
      size="sm"
    >
      <div className="space-y-6 p-6">
        <div className="space-y-2">
          <p className="text-xl font-medium tracking-tight text-primary">
            {t("DashboardPayments.ramps.sendConfirm.title", { amount })}
          </p>
          <p className="text-sm text-tertiary">
            {t("DashboardPayments.ramps.sendConfirm.description", { provider: providerLabel })}
          </p>
        </div>
        <dl className="space-y-3 text-sm">
          <div className="flex items-center justify-between gap-4">
            <dt className="text-tertiary">
              {t("DashboardPayments.ramps.sendConfirm.to", { provider: providerLabel })}
            </dt>
            <dd className="flex min-w-0 items-center gap-2">
              <span className="font-mono text-primary">
                {shortenAddress(depositTarget.destinationAddress)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => void copy(depositTarget.destinationAddress)}
              >
                {copied
                  ? t("DashboardPayments.ramps.addressCopied")
                  : t("DashboardPayments.ramps.copyAddress")}
              </Button>
            </dd>
          </div>
          {walletLabel ? (
            <div className="flex items-center justify-between gap-4">
              <dt className="text-tertiary">{t("DashboardPayments.ramps.sendConfirm.from")}</dt>
              <dd className="truncate text-primary">{walletLabel}</dd>
            </div>
          ) : null}
        </dl>
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("DashboardPayments.ramps.sendConfirm.notYet")}
          </Button>
          <Button type="button" iconLeft={<SendIcon />} onClick={onSend}>
            {t("DashboardPayments.ramps.sendCrypto", {
              amount: depositTarget.amount,
              token,
            })}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function OfframpFooterActionButton({
  action,
  wizard,
}: {
  action: OfframpFooterAction;
  wizard: OfframpFinalStepWizard;
}) {
  const t = useTranslations();
  const projectHref = useProjectHref();
  const [confirming, setConfirming] = useState(false);
  switch (action.kind) {
    case "transaction":
      return (
        <Button asChild type="button">
          <Link href={projectHref(transactionHref(action.transferId))}>
            {t("DashboardPayments.goToTransaction")}
          </Link>
        </Button>
      );
    case "send": {
      const token = getCryptoRailAssetLabel(wizard.selectedRampPair.assetRail);
      return (
        <>
          <InstructionActionButton
            variant="default"
            size="default"
            action={{
              loading: wizard.onchainSendLoading,
              succeeded: wizard.onchainSendResult !== null,
              disabled: !wizard.canSendOnchain,
              onClick: () => setConfirming(true),
              icon: <SendIcon />,
              idleLabel: t("DashboardPayments.ramps.sendCrypto", {
                amount: action.depositTarget.amount,
                token,
              }),
              busyLabel: t("DashboardPayments.ramps.sending"),
              doneLabel: t("DashboardPayments.ramps.transferSubmitted"),
            }}
          />
          <SendDepositDialog
            open={confirming}
            provider={wizard.transferStatus?.provider}
            depositTarget={action.depositTarget}
            token={token}
            walletLabel={wizard.selectedWallet ? walletPickerLabel(wizard.selectedWallet) : null}
            onClose={() => setConfirming(false)}
            onSend={() => {
              setConfirming(false);
              void wizard.sendCryptoToDeposit();
            }}
          />
        </>
      );
    }
    default: {
      const exhaustive: never = action;
      throw new Error(`Unhandled off-ramp footer action: ${String(exhaustive)}`);
    }
  }
}

/** Why the last send was refused, in place until the next attempt. */
export function OfframpSendError({ message }: { message: string | null }) {
  const t = useTranslations();
  return message ? (
    <div className="rounded-2xl border border-error-border bg-error-bg px-4 py-3 text-sm text-error">
      <p className="font-medium">{t("DashboardPayments.ramps.sendRefused")}</p>
      <p className="mt-1">{message}</p>
    </div>
  ) : null;
}

/**
 * A sale that ended without paying out: what happened in SDP's words, and a
 * way back to the amount, since its quote can't take another deposit.
 */
export function OfframpOutcome({ wizard }: { wizard: OfframpFinalStepWizard }) {
  const t = useTranslations();
  return (
    <div className="space-y-5 rounded-2xl bg-fill-subtle p-5">
      <RampStatusPanel direction="offramp" transfer={wizard.transferStatus} />
      <Button
        type="button"
        variant="secondary"
        iconLeft={<RotateCcwIcon />}
        onClick={() => wizard.startOver("WITHDRAW")}
      >
        {t("DashboardPayments.ramps.startNewPayout")}
      </Button>
    </div>
  );
}
