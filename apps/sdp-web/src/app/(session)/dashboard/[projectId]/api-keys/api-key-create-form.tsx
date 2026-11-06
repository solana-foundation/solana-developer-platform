"use client";

import type { Action } from "@sdp/types/actions";
import type { ApiKeyWalletScope } from "@sdp/types/api-keys";
import type { PaymentsDashboardWallet } from "@sdp/types/payments";
import { Button } from "@sdp/ui/button";
import { Input } from "@sdp/ui/input";
import { KeyRoundIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { WizardFrame } from "@/components/wizard-frame";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useTimeZone } from "@/i18n/time-zone";
import { formatDate } from "@/lib/date-format";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { createApiKeyAction } from "./actions";
import { buildEndpointWalletPayload, defaultWalletScopeForGrants } from "./api-key-authoring";
import {
  type ApiKeyExpiryChoice,
  ApiKeyExpiryField,
  ApiKeyField,
  ApiKeyWalletPicker,
  resolveExpiryChoice,
} from "./api-key-form-parts";
import { ApiKeyGrantPicker } from "./api-key-grant-picker";
import {
  apiKeyEnvironmentLabel,
  apiKeyReach,
  apiKeyReachLabel,
  walletCountLabel,
} from "./api-key-presentation";

/**
 * A new key on one page: its name, what it may do, which wallets it signs with and how long it
 * lasts, with the footer saying what will be created. Until the wallets are picked, a key that
 * can execute starts on Selected wallets, so it signs with nothing it was not given (HOO-2099).
 * Created, it opens on its own page, which shows the secret once.
 */
export function ApiKeyCreateForm({
  wallets,
  offered,
  now,
}: {
  wallets: PaymentsDashboardWallet[];
  offered: readonly Action[];
  now: number;
}) {
  const t = useTranslations();
  const environment = useDashboardWorkspace().sdpEnvironment;
  const locale = useLocale();
  const timeZone = useTimeZone();
  const router = useRouter();
  const href = useProjectHref();
  const [name, setName] = useState("");
  const [grants, setGrants] = useState<Action[]>([]);
  const [walletChoice, setWalletChoice] = useState<{
    scope: ApiKeyWalletScope;
    ids: string[];
  } | null>(null);
  const [expiry, setExpiry] = useState<ApiKeyExpiryChoice>(90);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, startCreating] = useTransition();

  const walletScope = walletChoice?.scope ?? defaultWalletScopeForGrants(grants);
  const walletIds = walletChoice?.ids ?? [];
  const ready =
    name.trim() !== "" && grants.length > 0 && (walletScope === "all" || walletIds.length > 0);
  const expiresAt = resolveExpiryChoice(expiry, null, now);

  const summary = t("DashboardCustody.apiKeyPage.createSummary", {
    environment: apiKeyEnvironmentLabel(environment, t),
    reach:
      grants.length === 0
        ? t("DashboardCustody.apiKeyGrantsNone")
        : apiKeyReachLabel(apiKeyReach(grants), t),
    wallets:
      walletScope === "all"
        ? t("DashboardCustody.allWallets")
        : walletCountLabel(walletIds.length, t),
    expiry: expiresAt
      ? t("DashboardCustody.apiKeyPage.untilDate", {
          date: formatDate(locale, timeZone, expiresAt) ?? expiresAt,
        })
      : t("DashboardCustody.apiKeyPage.noExpiry"),
  });

  const submit = () => {
    setAttempted(true);
    if (!ready) return;
    startCreating(async () => {
      const result = await createApiKeyAction({
        name,
        grants,
        wallets: buildEndpointWalletPayload(walletScope, walletIds),
        expiresAt: resolveExpiryChoice(expiry, null, Date.now()),
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.push(href(`/dashboard/api-keys/${encodeURIComponent(result.keyId)}`));
    });
  };

  const footer = (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <p className="text-meta text-secondary sm:max-w-sm">{error ?? summary}</p>
      <div className="flex shrink-0 items-center justify-end gap-2">
        <Button
          variant="ghost"
          onClick={() => router.push(href("/dashboard/api-keys"))}
          disabled={creating}
        >
          {t("DashboardCustody.cancel")}
        </Button>
        <Button onClick={submit} loading={creating} iconLeft={<KeyRoundIcon className="size-4" />}>
          {t("DashboardCustody.apiKeyPage.createKey")}
        </Button>
      </div>
    </div>
  );

  return (
    <WizardFrame
      steps={[{ label: t("DashboardCustody.apiKeyPage.newKey"), title: "" }]}
      currentStep={0}
      hideProgress
      progressLabel={t("DashboardCustody.apiKeyPage.newKey")}
      footer={footer}
    >
      <div className="flex flex-col gap-8" data-api-key-create>
        <p className="text-body text-secondary">
          {t("DashboardCustody.apiKeyPage.forEnvironment", {
            environment: apiKeyEnvironmentLabel(environment, t),
          })}
        </p>
        <ApiKeyField label={t("DashboardCustody.name")} htmlFor="api-key-name">
          <Input
            id="api-key-name"
            value={name}
            maxLength={100}
            autoFocus
            placeholder={t("DashboardCustody.apiKeyPage.namePlaceholder")}
            onChange={(event) => setName(event.target.value)}
          />
          {attempted && name.trim() === "" ? (
            <p className="text-meta text-error">{t("DashboardCustody.apiKeyNameRequired")}</p>
          ) : null}
        </ApiKeyField>
        <ApiKeyField
          label={t("DashboardCustody.access")}
          hint={t("DashboardCustody.apiKeyPage.accessHint")}
        >
          <ApiKeyGrantPicker
            offered={offered}
            grants={grants}
            touched={attempted}
            onChange={setGrants}
          />
        </ApiKeyField>
        <ApiKeyField
          label={t("DashboardCustody.wallets")}
          hint={t("DashboardCustody.apiKeyPage.walletsHint")}
        >
          <ApiKeyWalletPicker
            wallets={wallets}
            walletScope={walletScope}
            walletIds={walletIds}
            showRequired={attempted}
            onChange={(scope, ids) => setWalletChoice({ scope, ids })}
          />
        </ApiKeyField>
        <ApiKeyField
          label={t("DashboardCustody.expires")}
          hint={t("DashboardCustody.apiKeyPage.expiresHint")}
          htmlFor="api-key-expiry"
        >
          <ApiKeyExpiryField id="api-key-expiry" choice={expiry} now={now} onChange={setExpiry} />
        </ApiKeyField>
      </div>
    </WizardFrame>
  );
}
