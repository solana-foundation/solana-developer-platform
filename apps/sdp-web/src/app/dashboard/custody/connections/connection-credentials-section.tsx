"use client";

import type { CustodyProvider } from "@sdp/types";
import { RefreshCwIcon, Undo2Icon } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { useLocale, useTranslations } from "@/i18n/provider";
import { cancelRotationAction, completeRotationAction } from "./connection-actions";
import type {
  CustodyCredentialLifecycle,
  CustodyInstallationConnection,
  LifecycleCredential,
} from "./connection-detail.data";
import {
  canRollBack,
  isCredentialManagedHere,
  resolveRetiredAt,
  rollbackHoursRemaining,
} from "./connection-detail.data";
import { DeactivateCredentialsDialog } from "./deactivate-credentials-dialog";
import { RollbackDialog } from "./rollback-dialog";
import { RotateCredentialsModal } from "./rotate-credentials-modal";
import { useCustodyAction } from "./use-custody-action";

function CredentialRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
      <dt className="w-28 shrink-0 text-tertiary">{label}</dt>
      <dd className="min-w-0 text-primary">{children}</dd>
    </div>
  );
}

/** `····9f2a` — the only part of an App ID ever shown back. */
function maskedAppId(credential: LifecycleCredential): string {
  const suffix = credential.displayMetadata.appIdSuffix;
  return suffix ? `····${suffix}` : "—";
}

function useDateFormatter() {
  const locale = useLocale();
  return (value: string | Date | null) => {
    if (!value) return null;
    const date = typeof value === "string" ? new Date(value) : value;
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleString(locale, {
      month: "short",
      day: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
      timeZoneName: "short",
    });
  };
}

/**
 * The credentials behind this connection, and what can be done to them.
 *
 * Three shapes, decided by the data rather than by the caller:
 *
 * - **Deployment-supplied** (`source === "runtime"`): SDP holds no secret to
 *   replace, so rotate and roll back are rendered disabled next to the reason.
 *   Disabled rather than hidden — a control that vanishes reads as a bug,
 *   while one that is visibly unavailable teaches where the change is made.
 * - **A rotation in flight**: a candidate exists but has not cut over. The
 *   current credentials are still the ones signing, and the only two honest
 *   moves are to settle the candidate or cancel it.
 * - **Settled**: rotate, plus roll back while the previous secret is still
 *   retained.
 */
export function ConnectionCredentialsSection({
  lifecycle,
  connection,
  provider,
  canManageCustody,
}: {
  lifecycle: CustodyCredentialLifecycle | "restricted" | null;
  connection: CustodyInstallationConnection;
  provider: CustodyProvider;
  canManageCustody: boolean;
}) {
  const t = useTranslations();
  const formatDate = useDateFormatter();
  const { pending, run } = useCustodyAction();
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [deactivateOpen, setDeactivateOpen] = useState(false);

  if (lifecycle === "restricted") {
    return (
      <section className="rounded-2xl border border-border-default bg-surface-raised p-6">
        <h2 className="text-base font-medium text-primary">
          {t("DashboardCustody.credentialsTitle")}
        </h2>
        <Callout variant="neutral" className="mt-3">
          {t("DashboardCustody.credentialsRestricted")}
        </Callout>
      </section>
    );
  }

  if (!lifecycle) {
    return (
      <section className="rounded-2xl border border-border-default bg-surface-raised p-6">
        <h2 className="text-base font-medium text-primary">
          {t("DashboardCustody.credentialsTitle")}
        </h2>
        {/* A failed read is not the same as "there are none", and the rest of
            the page is still true, so this says so and invites a retry. */}
        <Callout variant="warning" className="mt-3">
          {t("DashboardCustody.credentialsUnavailable")}
        </Callout>
      </section>
    );
  }

  const credential = lifecycle.providerCredential;
  const candidate = lifecycle.rotationCandidate;
  const managedHere = isCredentialManagedHere(credential);
  const rollbackState = canRollBack(lifecycle);
  const isDeactivated = connection.status === "deactivated";
  const isUnverified = credential.status === "pending" || credential.status === "creating";

  const credentialBadge = isDeactivated
    ? { variant: "outline" as const, label: t("DashboardCustody.credentialRetired") }
    : isUnverified
      ? { variant: "warning" as const, label: t("DashboardCustody.credentialUnverified") }
      : { variant: "success" as const, label: t("DashboardCustody.connectionStatusActive") };

  // Rotation and rollback need a settled, SDP-held credential on a live
  // connection. Everything else is read-only by nature, not by policy.
  const canAct = canManageCustody && managedHere && !isDeactivated && !isUnverified;

  const retiredAt = lifecycle.rollback ? resolveRetiredAt(lifecycle.rollback.expiresAt) : null;

  const handleSettleCandidate = async () => {
    await run(
      () => completeRotationAction(candidate!.id, provider, connection.id),
      {
        successTitle: t("DashboardCustody.rotateSuccessTitle"),
        failedTitle: t("DashboardCustody.rotateFailedTitle"),
        unknownTitle: t("DashboardCustody.rotateUnknownTitle"),
      }
    );
  };

  const handleCancelCandidate = async () => {
    await run(
      () => cancelRotationAction(candidate!.id, provider, connection.id),
      {
        successTitle: t("DashboardCustody.rotationCancelledTitle"),
        failedTitle: t("DashboardCustody.rotationCancelFailedTitle"),
        unknownTitle: t("DashboardCustody.rotationCancelUnknownTitle"),
      }
    );
  };

  return (
    <section className="rounded-2xl border border-border-default bg-surface-raised p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-medium text-primary">
          {t("DashboardCustody.credentialsTitle")}
        </h2>
        {!managedHere ? (
          <Badge variant="outline">{t("DashboardCustody.credentialDeploymentBadge")}</Badge>
        ) : null}
      </div>

      {candidate ? (
        <Callout
          variant="warning"
          className="mt-3"
          title={t("DashboardCustody.rotationPendingTitle")}
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p>{t("DashboardCustody.rotationPendingBody")}</p>
            {canManageCustody ? (
              <span className="flex shrink-0 items-center gap-2">
                <Button size="sm" onClick={handleSettleCandidate} disabled={pending}>
                  {t("DashboardCustody.rotationPendingRetry")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={handleCancelCandidate}
                  disabled={pending}
                >
                  {t("DashboardCustody.rotationPendingCancel")}
                </Button>
              </span>
            ) : null}
          </div>
        </Callout>
      ) : null}

      <div className="mt-3 grid gap-4 @3xl/connection-credentials:grid-cols-2">
        <div className="rounded-xl border border-border-default p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="truncate text-sm font-medium text-primary">{credential.label}</p>
            <Badge variant={credentialBadge.variant}>{credentialBadge.label}</Badge>
          </div>

          <dl className="mt-3 space-y-1">
            {!managedHere ? (
              <CredentialRow label={t("DashboardCustody.credentialManagedIn")}>
                {t("DashboardCustody.credentialDeploymentBadge")}
              </CredentialRow>
            ) : null}
            <CredentialRow label={t("DashboardCustody.credentialAppId")}>
              <span className="font-mono text-xs">{maskedAppId(credential)}</span>
            </CredentialRow>
            {managedHere ? (
              <CredentialRow label={t("DashboardCustody.credentialInUseSince")}>
                {formatDate(credential.createdAt) ?? "—"}
              </CredentialRow>
            ) : (
              <CredentialRow label={t("DashboardCustody.credentialVersion")}>
                {t("DashboardCustody.credentialVersionUntracked")}
              </CredentialRow>
            )}
            {managedHere && lifecycle.impact.connections.length > 1 ? (
              <CredentialRow label={t("DashboardCustody.credentialAlsoUsedBy")}>
                {t("DashboardCustody.credentialAlsoUsedByValue", {
                  count: lifecycle.impact.connections.length - 1,
                  projects: lifecycle.impact.projects.length,
                })}
              </CredentialRow>
            ) : null}
          </dl>

          {!managedHere ? (
            <p className="mt-3 rounded-xl border border-border-default bg-fill-subtle px-4 py-3 text-sm leading-6 text-secondary">
              {t("DashboardCustody.credentialDeploymentExplainer")}
            </p>
          ) : null}

          {!isDeactivated ? (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={!canAct || Boolean(candidate) || pending}
                onClick={() => setRotateOpen(true)}
                iconLeft={<RefreshCwIcon className="size-4" />}
              >
                {t("DashboardCustody.rotateAction")}
              </Button>
              {/* Rendered even when unavailable so the reason beside it has
                  something to explain. */}
              {!managedHere ? (
                <Button size="sm" variant="secondary" disabled>
                  {t("DashboardCustody.rollbackAction")}
                </Button>
              ) : null}
              {canManageCustody && managedHere ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setDeactivateOpen(true)}
                  disabled={pending}
                >
                  {t("DashboardCustody.deactivateCredentialsConfirm")}
                </Button>
              ) : null}
            </div>
          ) : (
            <p className="mt-3 text-sm text-tertiary">
              {t("DashboardCustody.credentialNoLongerUsed")}
            </p>
          )}
        </div>

        {lifecycle.rollback ? (
          <div className="rounded-xl border border-border-default p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium text-primary">
                {t("DashboardCustody.credentialPreviousVersion")}
              </p>
              <Badge variant="outline">{t("DashboardCustody.credentialRetired")}</Badge>
            </div>
            <dl className="mt-3 space-y-1">
              <CredentialRow label={t("DashboardCustody.credentialRetired")}>
                {formatDate(retiredAt) ?? "—"}
              </CredentialRow>
              <CredentialRow label={t("DashboardCustody.rollbackUntil")}>
                {formatDate(lifecycle.rollback.expiresAt) ?? "—"}
                {" "}
                <span className="text-tertiary">
                  {t("DashboardCustody.rollbackHoursLeft", {
                    hours: rollbackHoursRemaining(lifecycle.rollback.expiresAt),
                  })}
                </span>
              </CredentialRow>
            </dl>
            <div className="mt-4">
              <Button
                size="sm"
                variant="secondary"
                disabled={!canAct || !rollbackState.available || pending}
                onClick={() => setRollbackOpen(true)}
                iconLeft={<Undo2Icon className="size-4" />}
              >
                {t("DashboardCustody.rollbackAction")}
              </Button>
              {rollbackState.available === false &&
              rollbackState.reason === "rotation_pending" ? (
                <p className="mt-2 text-sm text-warning">
                  {t("DashboardCustody.rollbackBlockedByRotation")}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {canAct ? (
        <>
          <RotateCredentialsModal
            isOpen={rotateOpen}
            onClose={() => setRotateOpen(false)}
            lifecycle={lifecycle}
            provider={provider}
            connectionId={connection.id}
          />
          <RollbackDialog
            isOpen={rollbackOpen}
            onClose={() => setRollbackOpen(false)}
            lifecycle={lifecycle}
            provider={provider}
            connectionId={connection.id}
          />
          <DeactivateCredentialsDialog
            isOpen={deactivateOpen}
            onClose={() => setDeactivateOpen(false)}
            lifecycle={lifecycle}
            provider={provider}
            connectionId={connection.id}
          />
        </>
      ) : null}
    </section>
  );
}
