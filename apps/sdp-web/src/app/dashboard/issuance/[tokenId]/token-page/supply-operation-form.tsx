"use client";

import { type ReactNode, useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/i18n/provider";
import type { FundManagementModalAction } from "../token-fund-management-section";
import { getSignerWalletUnavailableReason } from "../token-management-workspace.utils";
import { TokenSignerSelect } from "../token-signer-select";
import type { TokenTabProps } from "./token-page.shared";

/**
 * Mint or burn opened in place under the issued supply, as the design draws it: the address,
 * the amount and a memo, then the action and Cancel. The default signer signs; a picker shows
 * only when the token has several signers and none is set. Burning says it cannot be undone.
 */
export function SupplyOperationForm({
  ops,
  action,
}: Pick<TokenTabProps, "ops"> & { action: FundManagementModalAction }) {
  const t = useTranslations();
  const id = useId();
  const mint = action === "mint";
  const form = mint ? ops.mintForm : ops.burnForm;
  const address = mint ? ops.mintForm.destination : ops.burnForm.source;
  const errors = mint ? ops.mintValidationErrors : ops.burnValidationErrors;
  const addressError = mint
    ? ops.mintValidationErrors.destination
    : ops.burnValidationErrors.source;
  const signer = ops.getActionSignerProps(action);
  const signerWallets = signer?.signerWallets ?? [];
  const needsSigner = signerWallets.length > 1 && !form.signingWalletId;

  const update = (patch: { address?: string; amount?: string; memo?: string }) => {
    if (mint) {
      ops.setMintForm((previous) => ({
        ...previous,
        ...(patch.address !== undefined && { destination: patch.address }),
        ...(patch.amount !== undefined && { amount: patch.amount }),
        ...(patch.memo !== undefined && { memo: patch.memo }),
      }));
    } else {
      ops.setBurnForm((previous) => ({
        ...previous,
        ...(patch.address !== undefined && { source: patch.address }),
        ...(patch.amount !== undefined && { amount: patch.amount }),
        ...(patch.memo !== undefined && { memo: patch.memo }),
      }));
    }
  };

  const blocked =
    !address.trim() ||
    !form.amount.trim() ||
    Boolean(ops.fundManagementDisabledReasons[action]) ||
    Boolean(signer?.signerUnavailableReason) ||
    Boolean(getSignerWalletUnavailableReason(signerWallets, form.signingWalletId, t)) ||
    needsSigner;
  const walletsListId = `${id}-wallets`;

  return (
    <form
      data-supply-operation={action}
      className="flex max-w-lg flex-col gap-4 pt-1 pb-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!blocked) ops.submitFundManagementAction(action);
      }}
    >
      {needsSigner && signer ? (
        <TokenSignerSelect
          signerWallets={signerWallets}
          signerWalletId={form.signingWalletId}
          signerUnavailableReason={signer.signerUnavailableReason}
          onSignerWalletIdChange={signer.onSignerWalletIdChange}
        />
      ) : null}
      <FormField
        id={`${id}-address`}
        label={t(mint ? "DashboardIssuance.forms.destination" : "DashboardIssuance.forms.source")}
        error={addressError}
      >
        <Input
          id={`${id}-address`}
          size="xl"
          autoComplete="off"
          list={walletsListId}
          placeholder={t("DashboardIssuance.newDesign.operations.addressPlaceholder")}
          value={address}
          aria-invalid={Boolean(addressError)}
          onChange={(event) => update({ address: event.currentTarget.value })}
        />
        {/* The project's wallets as suggestions; any Solana address can still be typed. */}
        <datalist id={walletsListId}>
          {ops.authorityWallets.map((wallet) => (
            <option key={wallet.id} value={wallet.publicKey}>
              {wallet.label?.trim() || wallet.publicKey}
            </option>
          ))}
        </datalist>
      </FormField>
      <FormField
        id={`${id}-amount`}
        label={t("DashboardIssuance.forms.amount")}
        error={errors.amount}
      >
        <Input
          id={`${id}-amount`}
          size="xl"
          autoComplete="off"
          inputMode="decimal"
          placeholder={t("DashboardIssuance.newDesign.operations.amountPlaceholder")}
          value={form.amount}
          aria-invalid={Boolean(errors.amount)}
          onChange={(event) => update({ amount: event.currentTarget.value.replace(/[\s,]/g, "") })}
        />
      </FormField>
      <FormField id={`${id}-memo`} label={t("DashboardIssuance.forms.memo")}>
        <Input
          id={`${id}-memo`}
          size="xl"
          autoComplete="off"
          placeholder={t("DashboardIssuance.newDesign.operations.memoPlaceholder")}
          value={form.memo}
          onChange={(event) => update({ memo: event.currentTarget.value })}
        />
      </FormField>
      {mint ? null : (
        <p className="text-body text-warning">
          {t("DashboardIssuance.newDesign.operations.burnWarning")}
        </p>
      )}
      <div className="flex items-center gap-4 [--button-height-md:2.125rem] @xl:[--button-height-md:1.75rem]">
        <Button
          type="submit"
          size="sm"
          variant={mint ? "default" : "destructive"}
          disabled={ops.isPending || blocked}
        >
          {t(
            mint
              ? "DashboardIssuance.management.mintTokens"
              : "DashboardIssuance.management.burnTokens"
          )}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={ops.isPending}
          onClick={ops.closeFundManagementModal}
        >
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
