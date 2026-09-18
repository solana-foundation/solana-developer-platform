"use client";

import type { CustodyProvider } from "@sdp/types";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
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
  canRotate,
}: {
  isOpen: boolean;
  onClose: () => void;
  lifecycle: CustodyCredentialLifecycle;
  provider: CustodyProvider;
  connectionId: string;
  canRotate: boolean;
}) {
  const t = useTranslations();
  const { pending, run } = useCustodyAction();
  const [recoveryLocked, setRecoveryLocked] = useState(false);
  const closeDisabled = pending || recoveryLocked;

  // Closing unmounts the form, so an unresolved attempt must settle first.
  return (
    <Modal
      isOpen={isOpen}
      onClose={closeDisabled ? undefined : onClose}
      closeDisabled={closeDisabled}
      size="lg"
      ariaLabel={t("DashboardCustody.rotateTitle")}
    >
      <RotateCredentialsForm
        canRotate={canRotate}
        connectionId={connectionId}
        lifecycle={lifecycle}
        onClose={onClose}
        onRecoveryLockChange={setRecoveryLocked}
        pending={pending}
        provider={provider}
        run={run}
        t={t}
      />
    </Modal>
  );
}

function RotateCredentialsForm({
  canRotate,
  connectionId,
  lifecycle,
  onClose,
  onRecoveryLockChange,
  pending,
  provider,
  run,
  t,
}: {
  canRotate: boolean;
  connectionId: string;
  lifecycle: CustodyCredentialLifecycle;
  onClose: () => void;
  onRecoveryLockChange: (locked: boolean) => void;
  pending: boolean;
  provider: CustodyProvider;
  run: ReturnType<typeof useCustodyAction>["run"];
  t: ReturnType<typeof useTranslations>;
}) {
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [attempt, setAttempt] = useState<FormData | null>(null);

  const connectionCount = lifecycle.impact.connections.length;
  const fieldsDisabled = pending || attempt !== null || !canRotate;

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || (!attempt && !canRotate)) return;
    // Keep fields, key and target together: a refresh may replace the current
    // credential while the original request's response is still unknown.
    const formData = attempt ?? new FormData();
    if (!attempt) {
      formData.set("credentialId", lifecycle.providerCredential.id);
      formData.set("provider", provider);
      formData.set("connectionId", connectionId);
      formData.set("idempotencyKey", idempotencyKey);
      formData.set("appId", appId);
      formData.set("appSecret", appSecret);
      setAttempt(formData);
    }
    onRecoveryLockChange(true);

    const result = await run(() => rotateCredentialsAction(formData, attempt !== null), {
      successTitle: t("DashboardCustody.rotateSuccessTitle"),
      successDescription: t("DashboardCustody.rotateSuccessDescription", {
        connections: connectionCount,
        projects: lifecycle.impact.projects.length,
      }),
      failedTitle: t("DashboardCustody.rotateFailedTitle"),
      unknownTitle: t("DashboardCustody.rotateUnknownTitle"),
    });

    if (result.status === "unknown") return;

    setAttempt(null);
    setAppSecret("");
    onRecoveryLockChange(false);

    // Only a conclusive refusal permits a corrected intent under a fresh key.
    if (result.status === "failed") {
      setIdempotencyKey(crypto.randomUUID());
    }

    if (result.status === "success") {
      onClose();
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5 p-6" data-custody-rotate-form>
      <h2 className="text-lg font-medium text-primary">{t("DashboardCustody.rotateTitle")}</h2>

      <CredentialImpactList impact={lifecycle.impact} provider={provider} />

      {attempt && !pending ? (
        <Callout variant="warning">{t("DashboardCustody.rotateRetryHint")}</Callout>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="custody-rotate-app-id">{t("DashboardCustody.providerPrivyAppId")}</Label>
        <Input
          id="custody-rotate-app-id"
          name="appId"
          required
          disabled={fieldsDisabled}
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
        disabled={fieldsDisabled}
      />

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={onClose}
          disabled={pending || attempt !== null}
        >
          {t("DashboardCustody.cancel")}
        </Button>
        <Button
          type="submit"
          disabled={pending || (!attempt && !canRotate)}
          iconLeft={
            pending ? (
              <Loader2Icon aria-hidden className="size-4 animate-spin" />
            ) : (
              <RefreshCwIcon aria-hidden className="size-4" />
            )
          }
        >
          {attempt
            ? t("Shared.SharedComponents.retry")
            : t("DashboardCustody.rotateConfirm", { count: connectionCount })}
        </Button>
      </div>
    </form>
  );
}
