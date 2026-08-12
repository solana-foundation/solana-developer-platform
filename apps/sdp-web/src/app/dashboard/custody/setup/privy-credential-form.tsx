"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useRef, useState, useTransition } from "react";
import {
  type PrivyByokSubmitResult,
  recheckPrivyCredentialAction,
  submitPrivyCredentialAction,
} from "@/app/dashboard/custody/byok-actions";
import { getCustodyProviderEntry } from "@/app/dashboard/custody/provider-catalog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/i18n/provider";

type CheckState =
  | { kind: "idle" }
  // Terminal for the attempt. With a `connectionId`, the failed connection
  // survives server-side and blocks fresh submissions, so the corrected
  // resubmit must replace the credentials on that connection.
  | { kind: "failed"; message: string; connectionId?: string }
  // The server refused to run the completion but keeps the pending
  // connection, so a fresh submission would be rejected as an existing setup;
  // re-running the same completion is the only path that can still converge.
  | { kind: "refused"; message: string; connectionId: string }
  // The connection's provider account is pinned server-side, so replacement
  // credentials are rejected and cancel is blocked: no submit from this form
  // can converge. A dead-end message, deliberately without a retry or
  // replacement action.
  | { kind: "unrecoverable"; message: string }
  | { kind: "retry_unknown"; connectionId: string }
  // The POST may have committed server-side. The exact payload is frozen so a
  // retry replays it verbatim under the same key; editing anything would make
  // the same key carry a different fingerprint and conflict forever.
  | { kind: "submit_unknown"; message: string; payload: FormData };

const FIELD_INPUT_CLASS =
  "h-12 rounded-2xl border-border-default bg-surface-raised px-4 shadow-none";

/**
 * The Privy install step: credential in, connection checked, wallet provisioned.
 *
 * Three rules this form owns:
 * - The app secret lives only in the DOM until submit and is never rehydrated
 *   from the API; after a terminal failure the field starts empty again.
 * - One idempotency key per submission attempt, held in state and reused if the
 *   same submission is retried, so a retry replays instead of duplicating.
 * - A `retry_unknown` outcome re-runs the same connection's completion rather
 *   than resubmitting; the credential and secret are already stored
 *   server-side.
 */
export function PrivyCredentialForm({
  formId,
  onRecoveryLockChange,
}: {
  formId: string;
  /** True while leaving this form would strand a stored credential or key. */
  onRecoveryLockChange?: (locked: boolean) => void;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [check, setCheck] = useState<CheckState>({ kind: "idle" });
  const [appSecret, setAppSecret] = useState("");
  const lastPayloadRef = useRef(new FormData());

  const privyFields = getCustodyProviderEntry("privy").storedCredentialSetup;
  if (privyFields.mode !== "self_service") {
    return null;
  }
  const labelField = privyFields.fields.find((field) => field.key === "credentialLabel");
  const defaultLabel =
    labelField && "defaultValue" in labelField ? (labelField.defaultValue ?? "") : "";

  const applyResult = (result: PrivyByokSubmitResult) => {
    if (result.status === "success") {
      onRecoveryLockChange?.(false);
      router.refresh();
      router.push("/dashboard/wallets");
      return;
    }
    if (result.status === "retry_unknown") {
      onRecoveryLockChange?.(true);
      setCheck({ kind: "retry_unknown", connectionId: result.connectionId });
      return;
    }
    if (result.status === "refused") {
      // The refusal left the pending connection behind server-side, so offer
      // the re-run that can still converge — but release the lock: a
      // deterministic refusal may need an external fix first, and the pending
      // connection survives leaving this step.
      onRecoveryLockChange?.(false);
      setCheck({
        kind: "refused",
        message: result.message,
        connectionId: result.connectionId,
      });
      return;
    }
    if (result.status === "unrecoverable") {
      // Nothing submitted from here can converge, so there is no recovery
      // state to strand by leaving; release the lock and show the dead end.
      onRecoveryLockChange?.(false);
      setCheck({ kind: "unrecoverable", message: result.message });
      return;
    }
    if (result.status === "failed") {
      // Terminal for this attempt: the next submit is a corrected one — fresh
      // key, and the rejected secret is cleared rather than left to be typed
      // onto. When the failed connection survives server-side its id rides
      // along so the resubmit replaces that connection's credentials instead
      // of colliding with it as a fresh submission.
      onRecoveryLockChange?.(false);
      setIdempotencyKey(crypto.randomUUID());
      setAppSecret("");
      setCheck({ kind: "failed", message: result.message, connectionId: result.connectionId });
      return;
    }
    if (result.status === "invalid") {
      // Nothing left the client, so there is nothing to recover: back to the
      // editable form with the message. The key is untouched — it was never
      // spent — the secret stays typed since no server saw it, and a pending
      // replacement target survives for the corrected submit.
      onRecoveryLockChange?.(false);
      setCheck((prev) => ({
        kind: "failed",
        message: result.message,
        connectionId: prev.kind === "failed" ? prev.connectionId : undefined,
      }));
      return;
    }
    // Transport-level uncertainty: the submission may have committed, so the
    // key is kept and the payload is frozen for a verbatim replay.
    onRecoveryLockChange?.(true);
    setCheck({ kind: "submit_unknown", message: result.message, payload: lastPayloadRef.current });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (isPending || !form.reportValidity()) {
      return;
    }
    const formData = new FormData(form);
    formData.set("idempotencyKey", idempotencyKey);
    if (check.kind === "failed" && check.connectionId) {
      // A conclusively failed connection blocks fresh submissions; the
      // corrected credentials must replace it instead.
      formData.set("connectionId", check.connectionId);
    }
    lastPayloadRef.current = formData;
    // Locked from the moment the POST leaves: if it commits while the response
    // is in flight, unmounting here would discard the only replay state.
    onRecoveryLockChange?.(true);
    startTransition(async () => {
      applyResult(await submitSafely(formData));
    });
  };

  // A rejected action call is the same uncertainty as a transport error inside
  // it: the POST may have committed with the response lost. Left unguarded, the
  // rejection would skip every branch that settles the recovery lock; mapped to
  // `error`, the frozen payload and retained key stay the recovery path.
  const submitSafely = async (payload: FormData): Promise<PrivyByokSubmitResult> => {
    try {
      return await submitPrivyCredentialAction(payload);
    } catch {
      return { status: "error", message: "" };
    }
  };

  const handleReplay = (payload: FormData) => {
    if (isPending) {
      return;
    }
    startTransition(async () => {
      applyResult(await submitSafely(payload));
    });
  };

  const handleRecheck = (connectionId: string) => {
    if (isPending) {
      return;
    }
    startTransition(async () => {
      try {
        applyResult(await recheckPrivyCredentialAction(connectionId));
      } catch {
        // The completion is replay-safe and the connection survives
        // server-side, so a lost action response leaves the current recovery
        // state valid; stay on it with the same re-check still offered.
      }
    });
  };

  if (check.kind === "submit_unknown") {
    return (
      <div className="grid gap-4" data-privy-byok-submit-retry="true">
        <p className="rounded-2xl border border-border-default bg-fill-subtle px-5 py-4 text-sm leading-6 text-secondary">
          {t("DashboardCustody.byokRetryUnknown")}
        </p>
        {/* Replay is the only safe exit: the submission may have committed as a
            pending connection, which the server will not let a fresh
            submission replace, so abandoning the key here would strand the
            install. The idempotent replay always converges on the real
            outcome. */}
        <div>
          <Button type="button" onClick={() => handleReplay(check.payload)} disabled={isPending}>
            {isPending ? t("DashboardCustody.byokChecking") : t("DashboardCustody.byokRetrySubmit")}
          </Button>
        </div>
      </div>
    );
  }

  if (check.kind === "unrecoverable") {
    return (
      <div className="grid gap-4" data-privy-byok-unrecoverable="true">
        <p
          role="alert"
          className="rounded-2xl border border-error-border bg-error-bg px-5 py-4 text-sm leading-6 text-error"
        >
          {check.message}
        </p>
      </div>
    );
  }

  if (check.kind === "refused") {
    return (
      <div className="grid gap-4" data-privy-byok-refused="true">
        <p
          role="alert"
          className="rounded-2xl border border-error-border bg-error-bg px-5 py-4 text-sm leading-6 text-error"
        >
          {check.message}
        </p>
        <div>
          <Button
            type="button"
            onClick={() => handleRecheck(check.connectionId)}
            disabled={isPending}
          >
            {isPending ? t("DashboardCustody.byokChecking") : t("DashboardCustody.byokCheckAgain")}
          </Button>
        </div>
      </div>
    );
  }

  if (check.kind === "retry_unknown") {
    return (
      <div className="grid gap-4" data-privy-byok-retry="true">
        <p className="rounded-2xl border border-border-default bg-fill-subtle px-5 py-4 text-sm leading-6 text-secondary">
          {t("DashboardCustody.byokRetryUnknown")}
        </p>
        <div>
          <Button
            type="button"
            onClick={() => handleRecheck(check.connectionId)}
            disabled={isPending}
          >
            {isPending ? t("DashboardCustody.byokChecking") : t("DashboardCustody.byokCheckAgain")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form id={formId} onSubmit={handleSubmit} className="grid gap-4" data-privy-byok-form="true">
      <div className="space-y-2">
        <Label htmlFor="byok-credential-label">
          {t("DashboardCustody.providerCredentialLabel")}
        </Label>
        <Input
          id="byok-credential-label"
          name="credentialLabel"
          defaultValue={defaultLabel}
          required
          className={FIELD_INPUT_CLASS}
        />
        <p className="text-sm leading-5 text-tertiary">
          {t("DashboardCustody.providerCredentialLabelDescription")}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="byok-app-id">{t("DashboardCustody.providerPrivyAppId")}</Label>
        <Input id="byok-app-id" name="appId" required className={FIELD_INPUT_CLASS} />
        <p className="text-sm leading-5 text-tertiary">
          {t("DashboardCustody.providerPrivyAppIdDescription")}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="byok-app-secret">{t("DashboardCustody.providerPrivyAppSecret")}</Label>
        <Input
          id="byok-app-secret"
          name="appSecret"
          type="password"
          autoComplete="off"
          required
          value={appSecret}
          onChange={(event) => setAppSecret(event.currentTarget.value)}
          className={FIELD_INPUT_CLASS}
        />
        <p className="text-sm leading-5 text-tertiary">
          {t("DashboardCustody.providerPrivyAppSecretDescription")}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="byok-wallet-label">
          {t("DashboardCustody.providerInitialWalletLabel")}
        </Label>
        <Input id="byok-wallet-label" name="walletLabel" className={FIELD_INPUT_CLASS} />
        <p className="text-sm leading-5 text-tertiary">
          {t("DashboardCustody.providerInitialWalletLabelDescription")}
        </p>
      </div>

      {check.kind === "failed" ? (
        <div
          role="alert"
          className="rounded-2xl border border-error-border bg-error-bg px-4 py-3 text-sm text-error"
        >
          {check.message}
        </div>
      ) : null}

      <div>
        <Button type="submit" disabled={isPending}>
          {isPending ? t("DashboardCustody.byokChecking") : t("DashboardCustody.byokConnect")}
        </Button>
      </div>
    </form>
  );
}
