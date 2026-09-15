"use client";

import type { CustodyProvider } from "@sdp/types";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
import { rotateCredentialsAction } from "./connection-actions";
import type { CustodyCredentialLifecycle } from "./connection-detail.data";
import { CredentialImpactList } from "./credential-impact-list";
import { SecretField } from "./secret-field";
import { useCustodyAction } from "./use-custody-action";

/**
 * Replaces the credentials behind this provider account.
 *
 * Rotation swaps the key, not the account: the wallets and their funds are
 * untouched, and the whole set of connections listed here cuts over together.
 * That set is shown before the confirm rather than after it, because the user
 * is committing every project in it, not just the one they are looking at.
 */
export function RotateCredentialsModal({
  isOpen,
  onClose,
  lifecycle,
  provider,
  connectionId,
}: {
  isOpen: boolean;
  onClose: () => void;
  lifecycle: CustodyCredentialLifecycle;
  provider: CustodyProvider;
  connectionId: string;
}) {
  const t = useTranslations();
  const { pending, run } = useCustodyAction();
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  // One key per user intent, reused verbatim if the same rotation is retried:
  // the server replays the original result for a repeated key instead of
  // opening a second rotation. It is re-minted when the dialog is reopened,
  // which is the point at which the user has decided to start over.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (isOpen) {
      setIdempotencyKey(crypto.randomUUID());
    } else {
      setAppSecret("");
      setAppId("");
    }
  }, [isOpen]);

  const connectionCount = lifecycle.impact.connections.length;

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData();
    formData.set("credentialId", lifecycle.providerCredential.id);
    formData.set("provider", provider);
    formData.set("connectionId", connectionId);
    formData.set("idempotencyKey", idempotencyKey);
    formData.set("appId", appId);
    formData.set("appSecret", appSecret);

    const result = await run(
      () => rotateCredentialsAction(formData),
      {
        successTitle: t("DashboardCustody.rotateSuccessTitle"),
        successDescription: t("DashboardCustody.rotateSuccessDescription", {
          connections: connectionCount,
          projects: lifecycle.impact.projects.length,
        }),
        failedTitle: t("DashboardCustody.rotateFailedTitle"),
        unknownTitle: t("DashboardCustody.rotateUnknownTitle"),
      }
    );

    // Clear the secret before anything else on every settled outcome: a
    // re-render must not leave it in a mounted input, and a rejected secret is
    // never the one to retry with.
    setAppSecret("");
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
      ariaLabel={t("DashboardCustody.rotateTitle")}
    >
      <form onSubmit={handleSubmit} className="space-y-5 p-6" data-custody-rotate-form>
        <h2 className="text-lg font-medium text-primary">{t("DashboardCustody.rotateTitle")}</h2>

        <CredentialImpactList impact={lifecycle.impact} provider={provider} />

        <div className="space-y-2">
          <Label htmlFor="custody-rotate-app-id">
            {t("DashboardCustody.providerPrivyAppId")}
          </Label>
          <Input
            id="custody-rotate-app-id"
            name="appId"
            required
            disabled={pending}
            value={appId}
            onChange={(event) => setAppId(event.target.value)}
          />
        </div>

        <SecretField
          name="appSecret"
          label={t("DashboardCustody.rotateNewSecretLabel")}
          hint={t("DashboardCustody.providerPrivyAppSecretDescription")}
          value={appSecret}
          onChange={setAppSecret}
          disabled={pending}
        />

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
            {t("DashboardCustody.cancel")}
          </Button>
          <Button
            type="submit"
            disabled={pending}
            iconLeft={
              pending ? (
                <Loader2Icon aria-hidden className="size-4 animate-spin" />
              ) : (
                <RefreshCwIcon aria-hidden className="size-4" />
              )
            }
          >
            {t("DashboardCustody.rotateConfirm", { count: connectionCount })}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
