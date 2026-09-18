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
  canCancel,
  canManageCustody,
  currentInUse,
  onCancel,
  onSettle,
  pending,
  t,
}: {
  canCancel: boolean;
  canManageCustody: boolean;
  currentInUse: boolean;
  onCancel: () => void;
  onSettle: () => void;
  pending: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <Callout variant="warning" className="mt-3" title={t("DashboardCustody.rotationPendingTitle")}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p>
          {t(
            currentInUse
              ? "DashboardCustody.rotationPendingBody"
              : "DashboardCustody.rotationUnusedBody"
          )}
        </p>
        {canManageCustody ? (
          <span className="flex shrink-0 items-center gap-2">
            <Button size="sm" onClick={onSettle} disabled={pending || !currentInUse}>
              {t("DashboardCustody.rotationPendingRetry")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={onCancel}
              disabled={pending || !canCancel}
            >
              {t("DashboardCustody.rotationPendingCancel")}
            </Button>
          </span>
        ) : null}
      </div>
    </Callout>
  );
}

function CredentialDetails({
  connectionId,
  credential,
  impact,
  managedHere,
  t,
}: {
  connectionId: string;
  credential: LifecycleCredential;
  impact: CustodyCredentialLifecycle["impact"];
  managedHere: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const formatDate = useDateFormatter();
  const otherConnections = impact.connections.filter(({ id }) => id !== connectionId);

  return (
    <>
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
        {managedHere && otherConnections.length > 0 ? (
          <CredentialRow label={t("DashboardCustody.credentialAlsoUsedBy")}>
            {t("DashboardCustody.credentialAlsoUsedByValue", {
              count: otherConnections.length,
              projects: new Set(otherConnections.map(({ projectId }) => projectId)).size,
            })}
          </CredentialRow>
        ) : null}
      </dl>

      {managedHere ? null : (
        <p className="mt-3 rounded-xl border border-border-default bg-fill-subtle px-4 py-3 text-sm leading-6 text-secondary">
          {t("DashboardCustody.credentialDeploymentExplainer")}
        </p>
      )}
    </>
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
  canDeactivate,
  connectionId,
  credential,
  hasPendingRotation,
  impact,
  managedHere,
  onDeactivate,
  onRotate,
  pending,
  t,
}: {
  badge: { variant: "outline" | "warning" | "success"; label: string };
  canAct: boolean;
  canDeactivate: boolean;
  connectionId: string;
  credential: LifecycleCredential;
  hasPendingRotation: boolean;
  impact: CustodyCredentialLifecycle["impact"];
  managedHere: boolean;
  onDeactivate: () => void;
  onRotate: () => void;
  pending: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const showControls =
    credential.status === "active" ||
    credential.status === "pending" ||
    credential.status === "creating";

  return (
    <div className="rounded-xl border border-border-default p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="truncate text-sm font-medium text-primary">{credential.label}</p>
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </div>

      <CredentialDetails
        connectionId={connectionId}
        credential={credential}
        impact={impact}
        managedHere={managedHere}
        t={t}
      />

      {credential.status === "deactivated" ? (
        <p className="mt-3 text-sm text-tertiary">
          {t("DashboardCustody.deactivateCredentialsSuccessDescription")}
        </p>
      ) : showControls ? (
        <>
          {managedHere && credential.status === "active" && impact.connections.length === 0 ? (
            <p className="mt-3 text-sm text-tertiary">
              {t("DashboardCustody.credentialNoLongerUsed")}
            </p>
          ) : null}
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
            {canDeactivate ? (
              <Button size="sm" variant="ghost" onClick={onDeactivate} disabled={pending}>
                {t("DashboardCustody.deactivateCredentialsConfirm")}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * The credential the previous rotation retired, and the window in which it can
 * still be restored. Rendered only while that window is open: once the API
 * stops returning `rollback`, restoration is no longer available.
 */
function PreviousCredentialCard({
  canAct,
  lifecycle,
  onRollBack,
  pending,
  t,
}: {
  canAct: boolean;
  lifecycle: CustodyCredentialLifecycle;
  onRollBack: () => void;
  pending: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const formatDate = useDateFormatter();

  // Owns the whole "is there anything to roll back to" question, rather than
  // leaving four derived values on the caller: once the API stops returning
  // `rollback`, restoration is no longer available and there is no card.
  if (!lifecycle.rollback) {
    return null;
  }

  const { expiresAt } = lifecycle.rollback;
  const rollbackState = canRollBack(lifecycle);
  const retiredAt = resolveRetiredAt(expiresAt);
  const canRollBackNow = canAct && rollbackState.available && !pending;
  const rotationBlocks =
    rollbackState.available === false && rollbackState.reason === "rotation_pending";

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

/**
 * `creating` and `pending` both mean the same thing to a reader — nothing has
 * verified this credential yet — so they share one badge.
 */
function resolveCredentialBadge(
  credential: LifecycleCredential,
  t: ReturnType<typeof useTranslations>
): { variant: "outline" | "warning" | "success"; label: string } {
  if (credential.status === "deactivated") {
    return { variant: "outline", label: t("DashboardCustody.connectionStatusDeactivated") };
  }
  if (credential.status === "retired") {
    return { variant: "outline", label: t("DashboardCustody.credentialRetired") };
  }
  if (credential.status === "failed_validation") {
    return { variant: "warning", label: t("DashboardCustody.credentialValidationFailed") };
  }
  if (credential.status === "pending" || credential.status === "creating") {
    return { variant: "warning", label: t("DashboardCustody.credentialUnverified") };
  }
  return { variant: "success", label: t("DashboardCustody.connectionStatusActive") };
}

/** The section's frame, for the two states that have no credential to show. */
function CredentialsNotice({
  message,
  title,
  variant,
}: {
  message: string;
  title: string;
  variant: "neutral" | "warning";
}) {
  return (
    <section className="rounded-2xl border border-border-default bg-surface-raised p-6">
      <h2 className="text-base font-medium text-primary">{title}</h2>
      <Callout variant={variant} className="mt-3">
        {message}
      </Callout>
    </section>
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
  const [rotationLifecycle, setRotationLifecycle] = useState<CustodyCredentialLifecycle | null>(
    null
  );
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [deactivateOpen, setDeactivateOpen] = useState(false);
  const availableLifecycle = typeof lifecycle === "object" ? lifecycle : null;
  const managedHere =
    availableLifecycle !== null && isCredentialManagedHere(availableLifecycle.providerCredential);
  const currentInUse =
    availableLifecycle?.providerCredential.status === "active" &&
    availableLifecycle.impact.connections.length > 0;
  const canAct = canManageCustody && managedHere && currentInUse;
  // A refresh can fail or change the active credential. Keep the open dialog
  // mounted so it can settle its original attempt, without enabling a new one.
  const rotationModal = rotationLifecycle ? (
    <RotateCredentialsModal
      isOpen
      onClose={() => setRotationLifecycle(null)}
      lifecycle={availableLifecycle ?? rotationLifecycle}
      provider={provider}
      connectionId={connection.id}
      canRotate={canAct}
    />
  ) : null;

  if (lifecycle === "restricted") {
    return (
      <>
        {rotationModal}
        <CredentialsNotice
          title={t("DashboardCustody.credentialsTitle")}
          variant="neutral"
          message={t("DashboardCustody.credentialsRestricted")}
        />
      </>
    );
  }

  // A failed read is not the same as "there are none", and the rest of the page
  // is still true, so this says so and invites a retry.
  if (!lifecycle) {
    return (
      <>
        {rotationModal}
        <CredentialsNotice
          title={t("DashboardCustody.credentialsTitle")}
          variant="warning"
          message={t("DashboardCustody.credentialsUnavailable")}
        />
      </>
    );
  }

  const credential = lifecycle.providerCredential;
  const candidate = lifecycle.rotationCandidate;
  const canDeactivate =
    canManageCustody &&
    managedHere &&
    (credential.status === "active" || credential.status === "pending");

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
    <>
      {rotationModal}
      {/* The named container the two-up credential grid below measures. */}
      <section className="@container/connection-credentials rounded-2xl border border-border-default bg-surface-raised p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-medium text-primary">
            {t("DashboardCustody.credentialsTitle")}
          </h2>
          {managedHere ? null : (
            <Badge variant="outline">{t("DashboardCustody.credentialDeploymentBadge")}</Badge>
          )}
        </div>

        {candidate ? (
          <PendingRotationCallout
            canCancel={
              candidate.status === "pending" || (candidate.status === "creating" && currentInUse)
            }
            canManageCustody={canManageCustody}
            currentInUse={currentInUse}
            onCancel={() => handleCancelCandidate(candidate.id)}
            onSettle={() => handleSettleCandidate(candidate.id)}
            pending={pending}
            t={t}
          />
        ) : null}

        <div className="mt-3 grid gap-4 @3xl/connection-credentials:grid-cols-2">
          <CurrentCredentialCard
            badge={resolveCredentialBadge(credential, t)}
            canAct={canAct}
            canDeactivate={canDeactivate}
            connectionId={connection.id}
            credential={credential}
            hasPendingRotation={Boolean(candidate)}
            impact={lifecycle.impact}
            managedHere={managedHere}
            onDeactivate={() => setDeactivateOpen(true)}
            onRotate={() => setRotationLifecycle(lifecycle)}
            pending={pending}
            t={t}
          />

          <PreviousCredentialCard
            canAct={canAct}
            lifecycle={lifecycle}
            onRollBack={() => setRollbackOpen(true)}
            pending={pending}
            t={t}
          />
        </div>

        {canAct ? (
          <RollbackDialog
            isOpen={rollbackOpen}
            onClose={() => setRollbackOpen(false)}
            lifecycle={lifecycle}
            provider={provider}
            connectionId={connection.id}
          />
        ) : null}
        {canDeactivate ? (
          <DeactivateCredentialsDialog
            isOpen={deactivateOpen}
            onClose={() => setDeactivateOpen(false)}
            lifecycle={lifecycle}
            provider={provider}
            connectionId={connection.id}
          />
        ) : null}
      </section>
    </>
  );
}
