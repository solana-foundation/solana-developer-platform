"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
import { type RingsWallet, rekeyRingsWallet } from "./helius-rings.data";

/**
 * The recovery of last resort for a paused wallet: republish its owner's record
 * under the keys the wallet derives now, at the cost of everything it holds.
 *
 * Typing the wallet's name is the gate. It is deliberately more work than a
 * confirm button, because the loss is silent — the notes stay on chain looking
 * untouched, and only the ability to open them is gone. The API asks for the
 * same name and refuses without it, so this dialog is the explanation rather
 * than the enforcement.
 */
export function RekeyWalletDialog({
  wallet,
  onRekeyed,
}: {
  wallet: RingsWallet;
  onRekeyed: () => Promise<void>;
}) {
  const t = useTranslations();

  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setConfirmation("");
      setError(null);
    }
  }, [open]);

  const matches = confirmation.trim() === wallet.name.trim();

  const handleSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!matches || submitting) return;

      setSubmitting(true);
      setError(null);
      try {
        const result = await rekeyRingsWallet(wallet.id, confirmation);
        if (result.error) {
          setError(result.error);
          return;
        }
        setOpen(false);
        await onRekeyed();
      } catch {
        // No reply at all. Left uncaught the dialog would sit on "Re-keying…"
        // with nothing coming, and the rotation may or may not have landed.
        setError(t("DashboardHeliusRings.rekey.failed"));
      } finally {
        setSubmitting(false);
      }
    },
    [confirmation, matches, submitting, wallet.id, onRekeyed, t]
  );

  const title = t("DashboardHeliusRings.rekey.title");

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        className="border-destructive text-destructive hover:bg-destructive/10"
        onClick={() => setOpen(true)}
      >
        {t("DashboardHeliusRings.rekey.action")}
      </Button>

      <Modal isOpen={open} ariaLabel={title} onClose={() => setOpen(false)} size="md">
        <form onSubmit={handleSubmit} className="p-6 pr-14">
          <h2 className="text-base font-medium text-primary">{title}</h2>
          <p className="mt-1 text-sm text-secondary">{wallet.name}</p>

          <Callout variant="danger" className="mt-4">
            {t("DashboardHeliusRings.rekey.warning")}
          </Callout>

          <p className="mt-4 text-pretty text-sm leading-6 text-secondary">
            {t("DashboardHeliusRings.rekey.effect")}
          </p>

          <div className="mt-4 flex flex-col gap-2">
            <Label htmlFor={`rekey-confirm-${wallet.id}`} className="text-sm">
              {t("DashboardHeliusRings.rekey.confirmPrompt", { name: wallet.name })}
            </Label>
            <Input
              id={`rekey-confirm-${wallet.id}`}
              name="confirmation"
              value={confirmation}
              onChange={(event) => setConfirmation(event.currentTarget.value)}
              placeholder={wallet.name}
              autoComplete="off"
              disabled={submitting}
            />
          </div>

          {error === null ? null : (
            <Callout variant="danger" live className="mt-4">
              {error}
            </Callout>
          )}

          <div className="mt-6 flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              {t("DashboardHeliusRings.rekey.cancel")}
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={!matches || submitting}
              aria-busy={submitting}
            >
              {t(
                submitting
                  ? "DashboardHeliusRings.rekey.submitting"
                  : "DashboardHeliusRings.rekey.submit"
              )}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
