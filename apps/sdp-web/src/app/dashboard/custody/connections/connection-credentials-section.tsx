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

/**
 * A rotation that started but never cut over.
 *
 * It offers both exits rather than only a retry: an unknown outcome leaves a
 * candidate on the server, and the user has to be able to either settle it or
 * discard it. Until one of those happens, rotation and rollback are both
 * blocked, so this callout sits above the cards that show them disabled.
 */
function PendingRotationCallout({
  canManageCustody,
  onCancel,
  onSettle,
  pending,
  t,
}: {
  canManageCustody: boolean;
  onCancel: () => void;
  onSettle: () => void;
  pending: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <Callout variant="warning" className="mt-3" title={t("DashboardCustody.rotationPendingTitle")}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p>{t("DashboardCustody.rotationPendingBody")}</p>
        {canManageCustody ? (
          <span className="flex shrink-0 items-center gap-2">
            <Button size="sm" onClick={onSettle} disabled={pending}>
              {t("DashboardCustody.rotationPendingRetry")}
            </Button>
            <Button size="sm" variant="secondary" onClick={onCancel} disabled={pending}>
              {t("DashboardCustody.rotationPendingCancel")}
            </Button>
          </span>
        ) : null}
      </div>
    </Callout>
  );
}

/**
 * The credential this connection signs with today.
 *
 * `managedHere` decides most of what it shows. A deployment-supplied credential
 * has no version SDP can track and nothing here can replace it, so its controls
 * render disabled beside an explanation rather than vanishing — a missing
 * button reads as a bug, a disabled one teaches why.
 */
function CurrentCredentialCard({
  badge,
  canAct,
  canManageCustody,
  credential,
  hasPendingRotation,
  impact,
  isDeactivated,
  managedHere,
  onDeactivate,
  onRotate,
  pending,
  t,
}: {
  badge: { variant: "outline" | "warning" | "success"; label: string };
  canAct: boolean;
  canManageCustody: boolean;
  credential: LifecycleCredential;
  hasPendingRotation: boolean;
  impact: CustodyCredentialLifecycle["impact"];
  isDeactivated: boolean;
  managedHere: boolean;
  onDeactivate: () => void;
  onRotate: () => void;
  pending: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const formatDate = useDateFormatter();
  const sharedConnectionCount = impact.connections.length - 1;

  return (
    <div className="rounded-xl border border-border-default p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="truncate text-sm font-medium text-primary">{credential.label}</p>
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </div>

      <dl className="mt-3 space-y-1">
        {managedHere ? null : (
          <CredentialRow label={t("DashboardCustody.credentialManagedIn")}>
            {t("DashboardCustody.credentialDeploymentBadge")}
          </CredentialRow>
        )}
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
        {managedHere && sharedConnectionCount > 0 ? (
          <CredentialRow label={t("DashboardCustody.credentialAlsoUsedBy")}>
            {t("DashboardCustody.credentialAlsoUsedByValue", {
              count: sharedConnectionCount,
              projects: impact.projects.length,
            })}
          </CredentialRow>
        ) : null}
      </dl>

      {managedHere ? null : (
        <p className="mt-3 rounded-xl border border-border-default bg-fill-subtle px-4 py-3 text-sm leading-6 text-secondary">
          {t("DashboardCustody.credentialDeploymentExplainer")}
        </p>
      )}

      {isDeactivated ? (
        <p className="mt-3 text-sm text-tertiary">{t("DashboardCustody.credentialNoLongerUsed")}</p>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={!canAct || hasPendingRotation || pending}
            onClick={onRotate}
            iconLeft={<RefreshCwIcon className="size-4" />}
          >
            {t("DashboardCustody.rotateAction")}
          </Button>
          {/* Rendered even when unavailable so the reason beside it has
              something to explain. */}
          {managedHere ? null : (
            <Button size="sm" variant="secondary" disabled>
              {t("DashboardCustody.rollbackAction")}
            </Button>
          )}
          {canManageCustody && managedHere ? (
            <Button size="sm" variant="ghost" onClick={onDeactivate} disabled={pending}>
              {t("DashboardCustody.deactivateCredentialsConfirm")}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * The credential the previous rotation retired, and the window in which it can
 * still be restored. Rendered only while that window is open: once the API
 * stops returning `rollback`, the secret is gone and there is nothing to show.
 */
function PreviousCredentialCard({
  canRollBackNow,
  expiresAt,
  onRollBack,
  retiredAt,
  rotationBlocks,
  t,
}: {
  canRollBackNow: boolean;
  expiresAt: string;
  onRollBack: () => void;
  retiredAt: Date | null;
  rotationBlocks: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const formatDate = useDateFormatter();

  return (
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
          {formatDate(expiresAt) ?? "—"}{" "}
          <span className="text-tertiary">
            {t("DashboardCustody.rollbackHoursLeft", {
              hours: rollbackHoursRemaining(expiresAt),
            })}
          </span>
        </CredentialRow>
      </dl>
      <div className="mt-4">
        <Button
          size="sm"
          variant="secondary"
          disabled={!canRollBackNow}
          onClick={onRollBack}
          iconLeft={<Undo2Icon className="size-4" />}
        >
          {t("DashboardCustody.rollbackAction")}
        </Button>
        {rotationBlocks ? (
          <p className="mt-2 text-sm text-warning">
            {t("DashboardCustody.rollbackBlockedByRotation")}
          </p>
        ) : null}
      </div>
    </div>
  );
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

  // Both take the id rather than closing over `candidate`, because only the
  // branch that renders these buttons knows a candidate exists.
  const handleSettleCandidate = async (candidateId: string) => {
    await run(() => completeRotationAction(candidateId, provider, connection.id), {
      successTitle: t("DashboardCustody.rotateSuccessTitle"),
      failedTitle: t("DashboardCustody.rotateFailedTitle"),
      unknownTitle: t("DashboardCustody.rotateUnknownTitle"),
    });
  };

  const handleCancelCandidate = async (candidateId: string) => {
    await run(() => cancelRotationAction(candidateId, provider, connection.id), {
      successTitle: t("DashboardCustody.rotationCancelledTitle"),
      failedTitle: t("DashboardCustody.rotationCancelFailedTitle"),
      unknownTitle: t("DashboardCustody.rotationCancelUnknownTitle"),
    });
  };

  return (
    // The named container the two-up credential grid below measures. Undeclared,
    // its `@3xl` query never matched and the cards stayed stacked at every width.
    <section className="@container/connection-credentials rounded-2xl border border-border-default bg-surface-raised p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-medium text-primary">
          {t("DashboardCustody.credentialsTitle")}
        </h2>
        {!managedHere ? (
          <Badge variant="outline">{t("DashboardCustody.credentialDeploymentBadge")}</Badge>
        ) : null}
      </div>

      {candidate ? (
        <PendingRotationCallout
          canManageCustody={canManageCustody}
          onCancel={() => handleCancelCandidate(candidate.id)}
          onSettle={() => handleSettleCandidate(candidate.id)}
          pending={pending}
          t={t}
        />
      ) : null}

      <div className="mt-3 grid gap-4 @3xl/connection-credentials:grid-cols-2">
        <CurrentCredentialCard
          badge={credentialBadge}
          canAct={canAct}
          canManageCustody={canManageCustody}
          credential={credential}
          hasPendingRotation={Boolean(candidate)}
          impact={lifecycle.impact}
          isDeactivated={isDeactivated}
          managedHere={managedHere}
          onDeactivate={() => setDeactivateOpen(true)}
          onRotate={() => setRotateOpen(true)}
          pending={pending}
          t={t}
        />

        {lifecycle.rollback ? (
          <PreviousCredentialCard
            canRollBackNow={canAct && rollbackState.available && !pending}
            expiresAt={lifecycle.rollback.expiresAt}
            onRollBack={() => setRollbackOpen(true)}
            retiredAt={retiredAt}
            rotationBlocks={
              rollbackState.available === false && rollbackState.reason === "rotation_pending"
            }
            t={t}
          />
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
