"use client";

import type { Action } from "@sdp/types/actions";
import { API_KEY_ENDED_STATUSES } from "@sdp/types/api-keys";
import type { PaymentsDashboardWallet } from "@sdp/types/payments";
import { Badge } from "@sdp/ui/badge";
import { Button } from "@sdp/ui/button";
import { HoldButton } from "@sdp/ui/hold-button";
import { Select, SelectItem } from "@sdp/ui/select";
import { RefreshCwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { DashboardPageTitle } from "@/components/dashboard-page-title";
import { RecordBlock, RecordRow, RecordStack } from "@/components/refresh-record";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useTimeZone } from "@/i18n/time-zone";
import { formatDateTime } from "@/lib/date-format";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { revokeApiKeyAction, rotateApiKeyAction } from "./actions";
import {
  ApiKeyAccessSection,
  ApiKeyDetailsSection,
  ApiKeyWalletsSection,
} from "./api-key-detail-sections";
import { useApiKeyFlashSecret } from "./api-key-flash-surface";
import { ApiKeyLifetimeText } from "./api-key-lifetime-text";
import {
  API_KEY_ROTATION_GRACE_HOURS,
  type ApiKeyDetails,
  type ApiKeyLifetime,
  type ApiKeyRotationGraceHours,
  apiKeyEnvironmentLabel,
  apiKeyLifetime,
  formatLastUsed,
  isApiKeyLive,
  walletCountLabel,
} from "./api-key-presentation";
import { ApiKeyReveal } from "./api-key-reveal";

const PANEL_CLASS =
  "flex flex-col gap-4 rounded-card border border-border-default bg-surface-raised p-5";

function graceLabel(
  hours: ApiKeyRotationGraceHours,
  t: ReturnType<typeof useTranslations>
): string {
  switch (hours) {
    case 0:
      return t("DashboardCustody.apiKeyPage.graceNow");
    case 1:
      return t("DashboardCustody.apiKeyPage.graceHour");
    case 24:
      return t("DashboardCustody.apiKeyPage.graceDay");
    case 168:
      return t("DashboardCustody.apiKeyPage.graceWeek");
    default: {
      const exhaustive: never = hours;
      throw new Error(`Unknown grace period: ${String(exhaustive)}`);
    }
  }
}

function statusBadge(
  kind: ApiKeyLifetime["kind"],
  revoked: boolean,
  t: ReturnType<typeof useTranslations>
) {
  if (revoked) {
    return <Badge variant="outline">{t("DashboardCustody.apiKeyPage.revoked")}</Badge>;
  }
  if (kind === "ended") {
    return <Badge variant="outline">{t("DashboardCustody.apiKeyPage.statusFilter.expired")}</Badge>;
  }
  if (kind === "stopping") {
    return (
      <Badge variant="warning">{t("DashboardCustody.apiKeyPage.statusFilter.replaced")}</Badge>
    );
  }
  return <Badge variant="success">{t("DashboardCustody.apiKeyPage.statusFilter.active")}</Badge>;
}

/** Rotating issues a new secret with everything else carried over; the old one runs out after the grace. */
function RotatePanel({
  apiKey,
  now,
  onCancel,
}: {
  apiKey: ApiKeyDetails;
  now: number;
  onCancel: () => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const timeZone = useTimeZone();
  const router = useRouter();
  const href = useProjectHref();
  const [grace, setGrace] = useState<ApiKeyRotationGraceHours>(24);
  const [rotating, startRotating] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const stopsAt = new Date(now + grace * 60 * 60 * 1000).toISOString();

  const rotate = () =>
    startRotating(async () => {
      const result = await rotateApiKeyAction(apiKey.id, grace);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.push(href(`/dashboard/api-keys/${encodeURIComponent(result.keyId)}`));
    });

  return (
    <div className={PANEL_CLASS} data-api-key-rotate-panel>
      <div>
        <p className="text-field font-medium text-primary">
          {t("DashboardCustody.apiKeyPage.rotateTitle", { name: apiKey.name })}
        </p>
        <p className="mt-0.5 text-body text-secondary">
          {t("DashboardCustody.apiKeyPage.rotateBody")}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor="api-key-rotation-grace" className="text-meta font-medium text-primary">
          {t("DashboardCustody.apiKeyPage.oldSecretStops")}
        </label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
          <Select
            id="api-key-rotation-grace"
            value={String(grace)}
            onValueChange={(value) => {
              const hours = API_KEY_ROTATION_GRACE_HOURS.find((option) => String(option) === value);
              if (hours !== undefined) setGrace(hours);
            }}
            className="sm:w-56"
          >
            {API_KEY_ROTATION_GRACE_HOURS.map((hours) => (
              <SelectItem key={hours} value={String(hours)}>
                {graceLabel(hours, t)}
              </SelectItem>
            ))}
          </Select>
          <span className="text-body text-secondary">
            {grace === 0
              ? t("DashboardCustody.apiKeyPage.stopsAtOnce")
              : formatDateTime(locale, timeZone, stopsAt)}
          </span>
        </div>
      </div>
      {error ? <p className="text-meta text-error">{error}</p> : null}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={rotating}>
          {t("DashboardCustody.cancel")}
        </Button>
        <Button onClick={rotate} loading={rotating}>
          {t("DashboardCustody.apiKeyPage.rotateKey")}
        </Button>
      </div>
    </div>
  );
}

/** Revoking ends the key at once; the hold is the confirmation, and payments it started can end with it. */
function RevokePanel({
  apiKey,
  now,
  walletsLabel,
  onRotateInstead,
  onKeep,
}: {
  apiKey: ApiKeyDetails;
  now: number;
  walletsLabel: string;
  onRotateInstead: (() => void) | null;
  onKeep: () => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const timeZone = useTimeZone();
  const router = useRouter();
  const href = useProjectHref();
  const [cancelRecurringPayments, setCancelRecurringPayments] = useState(false);
  const [revoking, startRevoking] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const revoke = () =>
    startRevoking(async () => {
      const result = await revokeApiKeyAction({
        keyId: apiKey.id,
        keyName: apiKey.name,
        cancelRecurringPayments,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      toast.success(result.message);
      router.push(href("/dashboard/api-keys"));
    });

  return (
    <div className={PANEL_CLASS} data-api-key-revoke-panel>
      <p className="text-field font-medium text-primary">
        {t("DashboardCustody.apiKeyPage.revokeTitle", { name: apiKey.name })}
      </p>
      <dl>
        <RecordRow label={t("DashboardCustody.lastUsed")}>
          {formatLastUsed(apiKey.lastUsedAt, now, locale, timeZone, t)}
        </RecordRow>
        <RecordRow label={t("DashboardCustody.wallets")}>{walletsLabel}</RecordRow>
      </dl>
      <label className="flex items-start gap-2 text-body text-secondary">
        <input
          type="checkbox"
          className="mt-1"
          checked={cancelRecurringPayments}
          disabled={revoking}
          onChange={(event) => setCancelRecurringPayments(event.currentTarget.checked)}
        />
        <span>
          <span className="block text-primary">
            {t("DashboardCustody.apiKeyCancelRecurringPayments")}
          </span>
          {t("DashboardCustody.apiKeyCancelRecurringPaymentsHelp")}
        </span>
      </label>
      <p className="text-body text-secondary">{t("DashboardCustody.apiKeyPage.revokeWarning")}</p>
      {error ? <p className="text-meta text-error">{error}</p> : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {onRotateInstead ? (
          <Button variant="ghost" onClick={onRotateInstead} disabled={revoking}>
            {t("DashboardCustody.apiKeyPage.rotateInstead")}
          </Button>
        ) : null}
        <Button variant="secondary" onClick={onKeep} disabled={revoking}>
          {t("DashboardCustody.apiKeyPage.keepKey")}
        </Button>
        <HoldButton onHoldComplete={revoke} disabled={revoking}>
          {t("DashboardCustody.apiKeyPage.holdToRevoke")}
        </HoldButton>
      </div>
    </div>
  );
}

/**
 * One API key and everything that can be done to it, on one scrolling page: the secret right
 * after it was made, what the key may do and sign with, its details, and rotating or revoking it.
 * A key that no longer works keeps its page to read, with no controls.
 */
export function ApiKeyDetailView({
  apiKey,
  wallets,
  offered,
  canManageApiKeys,
  apiBaseUrl,
  now,
}: {
  apiKey: ApiKeyDetails;
  wallets: PaymentsDashboardWallet[];
  offered: readonly Action[];
  canManageApiKeys: boolean;
  apiBaseUrl: string | null;
  now: number;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const timeZone = useTimeZone();
  const secret = useApiKeyFlashSecret(apiKey.id);
  const [secretSaved, setSecretSaved] = useState(false);
  const [panel, setPanel] = useState<"rotate" | "revoke" | null>(null);
  const lifetime = apiKeyLifetime(apiKey, now);
  const canManage = canManageApiKeys && isApiKeyLive(lifetime);
  // A replaced key is already on its way out: its replacement is the one to rotate.
  const canRotate = canManage && lifetime.kind !== "stopping";
  const walletsLabel =
    apiKey.walletScope === "all"
      ? t("DashboardCustody.apiKeyPage.signsWithAll")
      : t("DashboardCustody.apiKeyPage.signsWith", {
          wallets: walletCountLabel(apiKey.walletIds.length, t),
        });

  const lifetimeKind = lifetime.kind;
  const revoked = API_KEY_ENDED_STATUSES.some((status) => status === apiKey.status);
  const badge = useMemo(() => statusBadge(lifetimeKind, revoked, t), [lifetimeKind, revoked, t]);
  const actions = useMemo(
    () =>
      canRotate && panel !== "rotate" ? (
        <Button
          variant="outline"
          onClick={() => setPanel("rotate")}
          iconLeft={<RefreshCwIcon className="size-4" />}
        >
          {t("DashboardCustody.apiKeyPage.rotateKeyAction")}
        </Button>
      ) : undefined,
    [canRotate, panel, t]
  );
  const facts = [
    apiKey.keyPrefix,
    apiKeyEnvironmentLabel(apiKey.environment, t),
    t("DashboardCustody.apiKeyPage.lastUsedFact", {
      when: formatLastUsed(apiKey.lastUsedAt, now, locale, timeZone, t),
    }),
  ];

  return (
    <div className="@container w-full" data-api-key={apiKey.id}>
      <DashboardPageTitle title={apiKey.name} badge={badge} actions={actions} />
      <RecordStack spacing="loose">
        <div className="flex flex-col gap-4">
          <p className="flex flex-wrap items-center gap-x-1.5 text-body text-secondary">
            <span>{facts.join(" · ")}</span>
            {lifetime.kind === "never" || lifetime.kind === "until" ? null : (
              <>
                <span aria-hidden>·</span>
                <ApiKeyLifetimeText lifetime={lifetime} now={now} />
              </>
            )}
          </p>
          {panel === "rotate" ? (
            <RotatePanel apiKey={apiKey} now={now} onCancel={() => setPanel(null)} />
          ) : null}
        </div>

        {secret !== null && !secretSaved ? (
          <ApiKeyReveal
            secret={secret}
            grants={apiKey.grants}
            apiBaseUrl={apiBaseUrl}
            onSaved={() => setSecretSaved(true)}
          />
        ) : null}

        <ApiKeyAccessSection apiKey={apiKey} offered={offered} canEdit={canManage} />
        <ApiKeyWalletsSection apiKey={apiKey} wallets={wallets} canEdit={canManage} />
        <ApiKeyDetailsSection apiKey={apiKey} canEdit={canManage} now={now} />

        {canManage ? (
          <RecordBlock title={t("DashboardCustody.dangerZoneTitle")}>
            {panel === "revoke" ? (
              <RevokePanel
                apiKey={apiKey}
                now={now}
                walletsLabel={walletsLabel}
                onRotateInstead={canRotate ? () => setPanel("rotate") : null}
                onKeep={() => setPanel(null)}
              />
            ) : (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                <div className="min-w-0">
                  <p className="text-field font-medium text-primary">
                    {t("DashboardCustody.apiKeyPage.revokeKey")}
                  </p>
                  <p className="text-body text-secondary">
                    {t("DashboardCustody.apiKeyPage.revokeRowBody")}
                  </p>
                </div>
                <Button variant="destructive" size="sm" onClick={() => setPanel("revoke")}>
                  {t("DashboardCustody.apiKeyPage.revokeKeyAction")}
                </Button>
              </div>
            )}
          </RecordBlock>
        ) : null}
      </RecordStack>
    </div>
  );
}
