"use client";

import type { CustodyProvider } from "@sdp/types";
import { Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { WalletProviderMark } from "@/app/dashboard/custody/wallet-provider-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
import { createConnectionWalletAction } from "./connection-actions";
import { useCustodyAction } from "./use-custody-action";

/**
 * Creates a wallet inside this connection's provider account.
 *
 * The connection is shown, not chosen: the page already established which one
 * this is, and a picker here would invite creating the wallet somewhere the
 * user was not looking. Entry from the wallets overview, where there is no
 * connection in context, still goes through the setup wizard's selector.
 *
 * The hint about unknown outcomes is load-bearing. Wallet creation is not
 * idempotent on this route, so nothing retries it automatically — a silent
 * retry could mint a second wallet, and the honest instruction is to look at
 * the list first.
 */
export function AddWalletDialog({
  isOpen,
  onClose,
  connectionId,
  connectionLabel,
  provider,
  projectName,
}: {
  isOpen: boolean;
  onClose: () => void;
  connectionId: string;
  connectionLabel: string;
  provider: CustodyProvider;
  projectName: string;
}) {
  const t = useTranslations();
  const { pending, run } = useCustodyAction();
  const [label, setLabel] = useState("");

  useEffect(() => {
    if (!isOpen) setLabel("");
  }, [isOpen]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData();
    formData.set("connectionId", connectionId);
    formData.set("provider", provider);
    formData.set("label", label);

    const result = await run(() => createConnectionWalletAction(formData), {
      successTitle: t("DashboardCustody.addWalletSuccessTitle"),
      successDescription: t("DashboardCustody.addWalletSuccessDescription"),
      failedTitle: t("DashboardCustody.addWalletFailedTitle"),
      unknownTitle: t("DashboardCustody.addWalletUnknownTitle"),
    });
    if (result.status === "success") {
      onClose();
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={pending ? undefined : onClose}
      closeDisabled={pending}
      size="lg"
      ariaLabel={t("DashboardCustody.addWalletTitle")}
    >
      <form onSubmit={handleSubmit} className="space-y-5 p-6" data-custody-add-wallet-form>
        <h2 className="text-lg font-medium text-primary">{t("DashboardCustody.addWalletTitle")}</h2>

        <div className="space-y-2">
          <p className="text-sm font-medium text-primary">
            {t("DashboardCustody.connectionColumn")}
          </p>
          <div className="flex items-center justify-between gap-3 rounded-xl border border-border-default bg-fill-subtle px-4 py-3">
            <span className="flex min-w-0 items-center gap-2">
              <WalletProviderMark provider={provider} size="xs" />
              <span className="truncate text-sm text-primary">{connectionLabel}</span>
            </span>
            <span className="shrink-0 text-sm text-tertiary">{projectName}</span>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="custody-add-wallet-label">
            {t("DashboardCustody.addWalletNameLabel")}
          </Label>
          <Input
            id="custody-add-wallet-label"
            name="label"
            disabled={pending}
            placeholder={t("DashboardCustody.addWalletNamePlaceholder")}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
          <p className="text-sm leading-5 text-tertiary">{t("DashboardCustody.addWalletHint")}</p>
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
            {t("DashboardCustody.cancel")}
          </Button>
          <Button
            type="submit"
            disabled={pending}
            iconLeft={
              pending ? <Loader2Icon aria-hidden className="size-4 animate-spin" /> : undefined
            }
          >
            {t("DashboardCustody.addWalletConfirm")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
