"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectItem } from "@/components/ui/select";
import { useTranslations } from "@/i18n/provider";
import { getNoneConfirmationCopy } from "../token-authority-modal";
import { getSignerWalletUnavailableReason } from "../token-management-workspace.utils";
import { TokenSignerSelect } from "../token-signer-select";
import { shortAddress, type TokenTabProps } from "./token-page.shared";

const NONE = "__none_authority__";

const walletLabel = (wallet: PaymentsDashboardWallet) =>
  wallet.label?.trim() || shortAddress(wallet.publicKey);

/**
 * A deployed token's authority moved in place under its row, as the design draws it: the
 * holder, then Save authority and Cancel. Giving the authority up (None, where the role allows
 * it) says what that ends before it is saved. A holder outside the project's wallets stays
 * listed so the field shows who holds it now.
 */
export function AuthorityForm({ ops }: Pick<TokenTabProps, "ops">) {
  const t = useTranslations();
  const row = ops.authorityModalRow;
  if (!row) return null;

  const wallets = ops.authorityWallets.filter((wallet) => wallet.publicKey.trim());
  const current = (ops.authorityModalCurrentAuthority ?? "").trim();
  const next = ops.authorityModalNewAuthority.trim();
  const external = next && !wallets.some((wallet) => wallet.publicKey === next) ? next : null;
  const canRemove = !row.removalDisabledReason;
  const signer = ops.authorityModalSignerSelection;
  const signerWalletId = ops.authorityModalSignerWalletId;
  const needsSigner = signer.wallets.length > 1 && !signerWalletId;
  const signerReason =
    signer.unavailableReason ?? getSignerWalletUnavailableReason(signer.wallets, signerWalletId, t);
  const blocked = next === current || needsSigner || Boolean(signerReason) || (!next && !canRemove);

  return (
    <HolderForm
      submitLabel={t("DashboardIssuance.authority.save")}
      cancelLabel={t("DashboardIssuance.newDesign.permissions.cancel")}
      disabled={ops.isPending}
      blocked={blocked}
      onSubmit={() => void ops.handleAuthorityModalConfirm()}
      onCancel={ops.handleAuthorityModalClose}
      signer={
        needsSigner ? (
          <TokenSignerSelect
            signerWallets={signer.wallets}
            signerWalletId={signerWalletId}
            signerUnavailableReason={signer.unavailableReason}
            onSignerWalletIdChange={ops.setAuthorityModalSignerWalletId}
          />
        ) : null
      }
      field={
        <Select
          size="xl"
          ariaLabel={row.title}
          placeholder={t("DashboardIssuance.authority.selectWallet")}
          value={next || (canRemove ? NONE : "")}
          disabled={ops.isPending}
          onValueChange={(value) =>
            ops.setAuthorityModalNewAuthority(!value || value === NONE ? "" : value)
          }
        >
          {wallets.map((wallet) => (
            <SelectItem key={wallet.id} value={wallet.publicKey}>
              {walletLabel(wallet)}
            </SelectItem>
          ))}
          {external ? <SelectItem value={external}>{shortAddress(external)}</SelectItem> : null}
          {canRemove ? (
            <SelectItem value={NONE}>{t("DashboardIssuance.wallet.none")}</SelectItem>
          ) : null}
        </Select>
      }
    >
      {ops.authorityWalletsError ? (
        <p className="text-meta text-error">{ops.authorityWalletsError}</p>
      ) : null}
      {!next && canRemove && current ? (
        <p className="text-body text-warning">{getNoneConfirmationCopy(row, t).impact}</p>
      ) : null}
      {signerReason && !needsSigner ? <p className="text-meta text-error">{signerReason}</p> : null}
    </HolderForm>
  );
}

/**
 * A draft's holder picked in place: a wallet choice the draft keeps until it is deployed, so it
 * reaches the chain with the token rather than on Save.
 */
export function DraftHolderForm({
  title,
  wallets,
  value,
  onValueChange,
  onKeep,
  onCancel,
}: {
  title: string;
  wallets: PaymentsDashboardWallet[];
  value: string;
  onValueChange: (value: string) => void;
  onKeep: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations();
  return (
    <HolderForm
      submitLabel={t("DashboardIssuance.newDesign.permissions.keep")}
      cancelLabel={t("DashboardIssuance.newDesign.permissions.cancel")}
      blocked={!value}
      onSubmit={onKeep}
      onCancel={onCancel}
      field={
        <Select
          size="xl"
          ariaLabel={title}
          placeholder={t("DashboardIssuance.signer.select")}
          value={wallets.some((wallet) => wallet.id === value) ? value : ""}
          onValueChange={(next) => onValueChange(next ?? "")}
        >
          {wallets.map((wallet) => (
            <SelectItem key={wallet.id} value={wallet.id}>
              {walletLabel(wallet)}
            </SelectItem>
          ))}
        </Select>
      }
    >
      <p className="text-meta text-secondary">
        {t("DashboardIssuance.newDesign.permissions.draftHolderHint")}
      </p>
    </HolderForm>
  );
}

function HolderForm({
  field,
  signer,
  children,
  submitLabel,
  cancelLabel,
  disabled = false,
  blocked,
  onSubmit,
  onCancel,
}: {
  field: ReactNode;
  signer?: ReactNode;
  children?: ReactNode;
  submitLabel: string;
  cancelLabel: string;
  disabled?: boolean;
  blocked: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations();
  return (
    <form
      data-authority-form
      className="flex max-w-lg flex-col gap-4 ps-7 pt-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (!blocked && !disabled) onSubmit();
      }}
    >
      {signer}
      {/* The select is named by its row's title; this caption only draws the design's label. */}
      <div className="flex flex-col gap-2">
        <span aria-hidden="true" className="flex h-4 items-center text-meta text-secondary">
          {t("DashboardIssuance.newDesign.permissions.holder")}
        </span>
        {field}
      </div>
      {children}
      <div className="flex items-center gap-4 [--button-height-md:2.125rem] @xl:[--button-height-md:1.75rem]">
        <Button type="submit" size="sm" disabled={disabled || blocked}>
          {submitLabel}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onCancel}>
          {cancelLabel}
        </Button>
      </div>
    </form>
  );
}
