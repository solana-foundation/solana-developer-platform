"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { toast } from "sonner";
import { WalletMetadataCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
import { truncateMiddle } from "@/app/dashboard/custody/wallet-format-utils";
import { RecordBlock, RecordRow, RecordStack } from "@/components/refresh-record";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLocale, useTranslations } from "@/i18n/provider";
import { formatDate, formatDateTime } from "../../payments/payments-presentation";
import { updateWalletLabelAction } from "../actions";
import { useWalletActions } from "../use-wallet-actions";
import type { WalletPageView } from "./wallet-detail.shared";

const LABEL_MAX_LENGTH = 100;

/** The wallet's label, edited in place for a custody admin and read-only for everyone else. */
function LabelBlock({ wallet }: { wallet: WalletPageView }) {
  const t = useTranslations();
  const router = useRouter();
  const saved = wallet.label ?? "";
  const [draft, setDraft] = useState(saved);
  const [pending, startTransition] = useTransition();
  const changed = draft.trim() !== saved.trim();

  function save(event: FormEvent) {
    event.preventDefault();
    if (!changed || pending) return;
    const toastId = toast.loading(t("DashboardCustody.updatingWalletLabel"), {
      position: "bottom-right",
    });
    startTransition(async () => {
      const result = await updateWalletLabelAction(wallet.walletId, draft).catch((error) => ({
        status: "error" as const,
        message:
          error instanceof Error ? error.message : t("DashboardCustody.unableToUpdateWalletLabel"),
      }));
      if (result.status === "success") {
        toast.success(t("DashboardCustody.walletLabelUpdated"), {
          id: toastId,
          position: "bottom-right",
        });
        router.refresh();
        return;
      }
      toast.error(t("DashboardCustody.unableToUpdateWalletLabel"), {
        id: toastId,
        description: result.message,
        position: "bottom-right",
      });
    });
  }

  if (!wallet.canManageCustody) {
    return (
      <RecordBlock title={t("DashboardCustody.walletLabel")}>
        <dl>
          <RecordRow label={t("DashboardCustody.walletLabel")}>{wallet.name}</RecordRow>
        </dl>
      </RecordBlock>
    );
  }

  return (
    <RecordBlock title={t("DashboardCustody.walletLabel")}>
      <form onSubmit={save} className="flex max-w-[660px] flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Label htmlFor="wallet-settings-label">{t("DashboardCustody.walletLabel")}</Label>
          <Input
            id="wallet-settings-label"
            value={draft}
            maxLength={LABEL_MAX_LENGTH}
            autoComplete="off"
            onChange={(event) => setDraft(event.currentTarget.value)}
            placeholder={t("DashboardCustody.untitledWallet")}
            size="xl"
          />
          <p className="text-meta text-tertiary">{t("DashboardCustody.walletLabelSettingsHint")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="sm" disabled={!changed || pending}>
            {pending ? t("DashboardCustody.saving") : t("DashboardCustody.walletSaveChanges")}
          </Button>
          {changed && !pending ? (
            <>
              <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(saved)}>
                {t("DashboardCustody.walletDiscard")}
              </Button>
              <span className="text-body text-secondary">
                {t("DashboardCustody.walletNotSavedYet")}
              </span>
            </>
          ) : null}
        </div>
      </form>
    </RecordBlock>
  );
}

/** A signer check, run in simulation: whether the provider still signs for this wallet. */
function OwnershipBlock({ wallet }: { wallet: WalletPageView }) {
  const t = useTranslations();
  const locale = useLocale();
  const { isBusy, canRunSignerCheck, runSignerCheck, lastProof } = useWalletActions({
    walletId: wallet.walletId,
    walletAddress: wallet.publicKey,
    supportsSignerCheck: wallet.supportsSignerCheck,
  });
  const blocked = !wallet.isRuntimeExecutionAllowed
    ? t("DashboardCustody.walletProveRestricted")
    : !wallet.supportsSignerCheck
      ? t("DashboardCustody.walletProveUnsupported")
      : !canRunSignerCheck
        ? t("DashboardCustody.walletProveAdminOnly")
        : null;
  return (
    <RecordBlock title={t("DashboardCustody.walletOwnership")}>
      <div className="flex max-w-[660px] flex-col gap-4">
        {lastProof ? (
          <dl>
            <RecordRow label={t("DashboardCustody.walletLastProof")}>
              {t("DashboardCustody.walletProofPassed", {
                time: formatDateTime(lastProof.at, locale) ?? "",
              })}
            </RecordRow>
            <RecordRow label={t("DashboardCustody.signature")}>
              <span className="truncate tabular-nums" title={lastProof.signature}>
                {truncateMiddle(lastProof.signature, 6, 6)}
              </span>
              <WalletMetadataCopyButton
                value={lastProof.signature}
                label={t("DashboardCustody.signature")}
              />
            </RecordRow>
          </dl>
        ) : (
          <p className="max-w-[40em] text-body text-secondary">
            {t("DashboardCustody.walletProveBody")}
          </p>
        )}
        <div className="flex flex-col items-start gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isBusy || blocked !== null}
            aria-describedby={blocked ? "wallet-prove-why" : undefined}
            onClick={runSignerCheck}
          >
            {isBusy ? t("DashboardCustody.proving") : t("DashboardCustody.proveOwnership")}
          </Button>
          {blocked ? (
            <p id="wallet-prove-why" className="max-w-[40em] text-body text-secondary">
              {blocked}
            </p>
          ) : null}
        </div>
      </div>
    </RecordBlock>
  );
}

/** What can change about the wallet (its label), what cannot, and proving the keys still sign. */
export function WalletSettingsTab({ wallet }: { wallet: WalletPageView }) {
  const t = useTranslations();
  const locale = useLocale();
  return (
    <RecordStack>
      <LabelBlock wallet={wallet} />
      <RecordBlock title={t("DashboardCustody.walletFixedAtCreation")}>
        <dl className="max-w-[660px]">
          <RecordRow
            label={t("DashboardCustody.purpose")}
            hint={t("DashboardCustody.walletPurposeFixedInfo")}
          >
            {wallet.purposeLabel ?? (
              <span className="text-tertiary">{t("DashboardCustody.unknown")}</span>
            )}
          </RecordRow>
          <RecordRow
            label={t("DashboardCustody.created")}
            hint={t("DashboardCustody.walletCreatedFixedInfo")}
          >
            {formatDate(wallet.createdAt, locale) ?? "—"}
          </RecordRow>
          <RecordRow label={t("DashboardCustody.provider")}>{wallet.providerName}</RecordRow>
        </dl>
      </RecordBlock>
      <OwnershipBlock wallet={wallet} />
    </RecordStack>
  );
}
