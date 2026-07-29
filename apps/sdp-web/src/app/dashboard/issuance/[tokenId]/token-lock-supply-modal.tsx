"use client";

import type { PaymentsDashboardWallet, Token } from "@sdp/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/i18n/provider";
import { TokenSignerSelect } from "./token-signer-select";

/**
 * Confirmation body for "lock supply": mint the remainder up to the configured
 * max supply, then revoke the mint authority so the total can never change.
 *
 * SPL has no supply-cap field and `InitializeMint` requires a mint authority, so
 * this two-step sequence is the only way to reach a genuinely fixed supply. It is
 * irreversible, and it is two transactions — hence the explicit warning and the
 * partial-failure branch when the mint landed but the revoke did not.
 */
export function TokenLockSupplyModal({
  token,
  remaining,
  alreadyMinted,
  revokeFailed,
  destination,
  onDestinationChange,
  signerWallets,
  signerWalletId,
  signerUnavailableReason,
  onSignerWalletIdChange,
  isPending,
  onCancel,
  onConfirm,
}: {
  token: Token;
  /** Whole-token decimal string; "0" when the cap is already met. */
  remaining: string;
  alreadyMinted: boolean;
  revokeFailed: boolean;
  destination: string;
  onDestinationChange: (value: string) => void;
  signerWallets: PaymentsDashboardWallet[];
  signerWalletId: string;
  signerUnavailableReason: string | null;
  onSignerWalletIdChange: (value: string) => void;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations();
  // "0" or an unparseable remainder both mean there is nothing to mint, so the
  // flow degenerates to a bare revoke and the destination field is irrelevant.
  const needsMint = !alreadyMinted && /[1-9]/.test(remaining);
  const confirmDisabled = isPending || (needsMint && destination.trim().length === 0);

  return (
    <div className="space-y-5">
      <div>
        <h4 className="pr-10 text-[24px] leading-[1.15] font-medium text-primary">
          {t("DashboardIssuance.management.lockSupplyTitle")}
        </h4>
        <p className="mt-2 text-[15px] leading-[1.45] text-secondary">
          {needsMint
            ? t("DashboardIssuance.management.lockSupplyDescription")
            : t("DashboardIssuance.management.lockSupplyDescriptionRevokeOnly")}
        </p>
      </div>

      {revokeFailed ? (
        <div className="rounded-xl border border-destructive-border bg-destructive-bg px-4 py-3">
          <p className="text-sm font-medium text-destructive-strongest">
            {t("DashboardIssuance.management.lockSupplyPartialTitle")}
          </p>
          <p className="mt-1 text-sm leading-[1.5] text-destructive-strongest">
            {t("DashboardIssuance.management.lockSupplyPartialBody")}
          </p>
        </div>
      ) : null}

      <dl className="space-y-2 rounded-xl border border-border-default bg-fill-subtle px-4 py-3">
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-sm text-secondary">
            {t("DashboardIssuance.management.lockSupplyCurrentSupply")}
          </dt>
          <dd className="text-sm font-medium text-primary">
            {token.totalSupply} {token.symbol}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-sm text-secondary">
            {t("DashboardIssuance.management.lockSupplyMaxSupply")}
          </dt>
          <dd className="text-sm font-medium text-primary">
            {token.maxSupply} {token.symbol}
          </dd>
        </div>
        {needsMint ? (
          <div className="flex items-baseline justify-between gap-4 border-t border-border-subtle pt-2">
            <dt className="text-sm text-secondary">
              {t("DashboardIssuance.management.lockSupplyWillMint")}
            </dt>
            <dd className="text-sm font-medium text-primary">
              {remaining} {token.symbol}
            </dd>
          </div>
        ) : null}
      </dl>

      {needsMint ? (
        <div className="grid gap-1.5">
          <Label htmlFor="lock-supply-destination">
            {t("DashboardIssuance.management.lockSupplyDestination")}
          </Label>
          <Input
            id="lock-supply-destination"
            value={destination}
            onChange={(event) => onDestinationChange(event.currentTarget.value)}
            placeholder={t("DashboardIssuance.forms.destinationPlaceholder")}
            description={t("DashboardIssuance.management.lockSupplyDestinationHint")}
            disabled={isPending}
          />
        </div>
      ) : null}

      <TokenSignerSelect
        signerWallets={signerWallets}
        signerWalletId={signerWalletId}
        signerUnavailableReason={signerUnavailableReason}
        onSignerWalletIdChange={onSignerWalletIdChange}
      />

      <div className="rounded-xl border border-destructive-border bg-destructive-bg px-4 py-3">
        <p className="text-sm font-medium text-destructive-strongest">
          {t("DashboardIssuance.authority.whatThisMeans")}
        </p>
        <p className="mt-1 text-sm leading-[1.5] text-destructive-strongest">
          {t("DashboardIssuance.management.lockSupplyImpact", { symbol: token.symbol })}
        </p>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
          {t("DashboardIssuance.workspace.cancel")}
        </Button>
        <Button type="button" onClick={onConfirm} disabled={confirmDisabled}>
          {revokeFailed
            ? t("DashboardIssuance.management.lockSupplyRetryRevoke")
            : t("DashboardIssuance.management.lockSupplyConfirm")}
        </Button>
      </div>
    </div>
  );
}
