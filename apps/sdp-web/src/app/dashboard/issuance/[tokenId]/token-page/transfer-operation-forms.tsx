"use client";

import { type ReactNode, useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/i18n/provider";
import {
  getSignerWalletUnavailableReason,
  isValidSolanaAddressInput,
} from "../token-management-workspace.utils";
import { TokenSignerSelect } from "../token-signer-select";
import type { TokenTabProps } from "./token-page.shared";

/**
 * The design's 34px buttons on a phone, 28px once a row lays out across. The forms start 38px
 * under the row's value and keep Cancel's words 22px from the action, as the design measures.
 */
const FORM_BUTTON_HEIGHT = "[--button-height-md:2.125rem] @xl:[--button-height-md:1.75rem]";

/**
 * Pausing (or resuming) transfers opened in place under the Transfers row, as the design draws
 * it: what it does to every holder, then the action and Cancel. It is the confirmation itself,
 * so the action runs without a dialog (one still asks which wallet signs when several can).
 */
export function PauseTransfersForm({
  ops,
  paused,
  onClose,
}: Pick<TokenTabProps, "ops"> & { paused: boolean; onClose: () => void }) {
  const t = useTranslations();
  return (
    <div data-transfer-operation="pause" className="flex max-w-lg flex-col gap-4 pt-2.5 pb-2">
      <p className="text-body text-warning">
        {t(
          paused
            ? "DashboardIssuance.newDesign.operations.resumeWarning"
            : "DashboardIssuance.newDesign.operations.pauseWarning"
        )}
      </p>
      <div className={`flex items-center gap-2.5 ${FORM_BUTTON_HEIGHT}`}>
        <Button
          type="button"
          size="sm"
          disabled={ops.isPending}
          onClick={() => {
            onClose();
            ops.handlePause(!paused, { confirmed: true });
          }}
        >
          {t(
            paused
              ? "DashboardIssuance.newDesign.operations.resumeTitle"
              : "DashboardIssuance.newDesign.operations.pauseTitle"
          )}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={ops.isPending} onClick={onClose}>
          {t("DashboardIssuance.workspace.cancel")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Freezing an account opened in place under the freeze authority, as the design draws it: the
 * holder's address and the reason the audit history keeps, then the action and Cancel. When
 * several wallets hold the freeze authority, the form first asks which one signs. The freeze
 * still confirms in its dialog, with the token, the address and the network.
 */
export function FreezeAccountForm({
  ops,
  onClose,
}: Pick<TokenTabProps, "ops"> & { onClose: () => void }) {
  const t = useTranslations();
  const id = useId();
  const address = ops.freezeForm.accountAddress;
  const invalid = address.trim().length > 0 && !isValidSolanaAddressInput(address);
  const signer = ops.getActionSignerProps("freeze");
  // The freeze sends the chosen wallet, else the only one; with several and none chosen it
  // could not tell which signs, so it waits for a choice.
  const chooseSigner = signer.signerWallets.length > 1;
  const signerWalletId = ops.freezeForm.signingWalletId || signer.defaultSignerWalletId || "";
  const signerBlocked =
    Boolean(signer.signerUnavailableReason) ||
    Boolean(getSignerWalletUnavailableReason(signer.signerWallets, signerWalletId, t)) ||
    (chooseSigner && !ops.freezeForm.signingWalletId);
  const blocked = !address.trim() || invalid || signerBlocked;

  return (
    <form
      data-transfer-operation="freeze"
      className="flex max-w-lg flex-col gap-4 pt-2.5 pb-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (blocked || ops.isPending) return;
        onClose();
        ops.handleFreeze(false);
      }}
    >
      {chooseSigner ? (
        <TokenSignerSelect
          signerWallets={signer.signerWallets}
          signerWalletId={ops.freezeForm.signingWalletId}
          signerUnavailableReason={signer.signerUnavailableReason}
          onSignerWalletIdChange={signer.onSignerWalletIdChange}
        />
      ) : null}
      <FormField
        id={`${id}-address`}
        label={t("DashboardIssuance.newDesign.operations.freezeAddress")}
        error={invalid ? t("DashboardIssuance.forms.enterSolanaAddress") : null}
      >
        <Input
          id={`${id}-address`}
          size="xl"
          autoComplete="off"
          placeholder={t("DashboardIssuance.newDesign.operations.freezeAddressPlaceholder")}
          value={address}
          aria-invalid={invalid}
          onChange={(event) => {
            const accountAddress = event.currentTarget.value;
            ops.setFreezeForm((previous) => ({ ...previous, accountAddress }));
          }}
        />
      </FormField>
      <FormField
        id={`${id}-reason`}
        label={t("DashboardIssuance.newDesign.operations.freezeReason")}
      >
        <Input
          id={`${id}-reason`}
          size="xl"
          autoComplete="off"
          placeholder={t("DashboardIssuance.newDesign.operations.freezeReasonPlaceholder")}
          value={ops.freezeForm.reason}
          onChange={(event) => {
            const reason = event.currentTarget.value;
            ops.setFreezeForm((previous) => ({ ...previous, reason }));
          }}
        />
      </FormField>
      <div className={`flex items-center gap-2.5 ${FORM_BUTTON_HEIGHT}`}>
        <Button type="submit" size="sm" disabled={ops.isPending || blocked}>
          {t("DashboardIssuance.newDesign.operations.freezeSubmit")}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={ops.isPending} onClick={onClose}>
          {t("DashboardIssuance.workspace.cancel")}
        </Button>
      </div>
    </form>
  );
}

function FormField({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id} className="flex h-4 items-center text-meta font-normal text-secondary">
        {label}
      </Label>
      {children}
      {error ? <p className="text-meta text-error">{error}</p> : null}
    </div>
  );
}
