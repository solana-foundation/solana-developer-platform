"use client";

import { type FormEvent, useState, useTransition } from "react";
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
import { useDashboardRouter } from "@/lib/use-dashboard-router";

type CheckState =
  | { kind: "idle" }
  | { kind: "failed"; message: string }
  | { kind: "retry_unknown"; providerCredentialId: string };

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
 * - A `retry_unknown` outcome re-checks the same credential rather than
 *   resubmitting; the credential and secret are already stored server-side.
 */
export function PrivyCredentialForm({ formId }: { formId: string }) {
  const t = useTranslations();
  const router = useDashboardRouter();
  const [isPending, startTransition] = useTransition();
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [check, setCheck] = useState<CheckState>({ kind: "idle" });

  const privyFields = getCustodyProviderEntry("privy").storedCredentialSetup;
  if (privyFields.mode !== "self_service") {
    return null;
  }
  const labelField = privyFields.fields.find((field) => field.key === "credentialLabel");
  const defaultLabel =
    labelField && "defaultValue" in labelField ? (labelField.defaultValue ?? "") : "";

  const applyResult = (result: PrivyByokSubmitResult) => {
    if (result.status === "success") {
      router.refresh();
      router.push("/dashboard/wallets");
      return;
    }
    if (result.status === "retry_unknown") {
      setCheck({ kind: "retry_unknown", providerCredentialId: result.providerCredentialId });
      return;
    }
    // Terminal for this attempt: conclusively-invalid credentials are removed
    // server-side, so the next submit is a fresh one and needs a fresh key.
    setIdempotencyKey(crypto.randomUUID());
    setCheck({ kind: "failed", message: result.message });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (isPending || !form.reportValidity()) {
      return;
    }
    const formData = new FormData(form);
    formData.set("idempotencyKey", idempotencyKey);
    startTransition(async () => {
      applyResult(await submitPrivyCredentialAction(formData));
    });
  };

  const handleRecheck = (providerCredentialId: string) => {
    if (isPending) {
      return;
    }
    startTransition(async () => {
      applyResult(await recheckPrivyCredentialAction(providerCredentialId));
    });
  };

  if (check.kind === "retry_unknown") {
    return (
      <div className="grid gap-4" data-privy-byok-retry="true">
        <p className="rounded-2xl border border-border-default bg-fill-subtle px-5 py-4 text-sm leading-6 text-secondary">
          {t("DashboardCustody.byokRetryUnknown")}
        </p>
        <div>
          <Button
            type="button"
            onClick={() => handleRecheck(check.providerCredentialId)}
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
        <Label htmlFor="byok-scope">{t("DashboardCustody.providerCredentialScope")}</Label>
        <select
          id="byok-scope"
          name="scope"
          defaultValue="organization"
          className="h-12 w-full rounded-2xl border border-border-default bg-surface-raised px-4 text-sm text-primary"
        >
          <option value="organization">
            {t("DashboardCustody.providerCredentialScopeOrganization")}
          </option>
          <option value="project">{t("DashboardCustody.providerCredentialScopeProject")}</option>
        </select>
        <p className="text-sm leading-5 text-tertiary">
          {t("DashboardCustody.providerCredentialScopeDescription")}
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
