"use client";

import type { CustodyProvider } from "@sdp/types/custody";
import { Button } from "@sdp/ui/button";
import { Callout } from "@sdp/ui/callout";
import { StatusText, type StatusTone } from "@sdp/ui/status-text";
import { useState } from "react";
import { RecordBlock, RecordLine } from "@/components/refresh-record";
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
  rollbackHoursRemaining,
} from "./connection-detail.data";
import { RollbackDialog } from "./rollback-dialog";
import { RotateCredentialsModal } from "./rotate-credentials-modal";
import { useCustodyAction } from "./use-custody-action";

/** `····9f2a` — the only part of an App ID ever shown back. */
function maskedCredentialId(credential: LifecycleCredential): string {
  const suffix = credential.displayMetadata.appIdSuffix ?? credential.displayMetadata.apiKeySuffix;
  return suffix ? `····${suffix}` : "—";
}

/**
 * A rotation that started but never cut over.
 *
 * It offers both exits rather than only a retry: an unknown outcome leaves a
 * candidate on the server, and the user has to be able to either settle it or
 * discard it. Until one of those happens, rotation and rollback are both
 * blocked, so this callout sits above the rows that show them unavailable.
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
    <Callout variant="warning" title={t("DashboardCustody.rotationPendingTitle")}>
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

/** The credential's state as a word, when it is anything but active. */
const CREDENTIAL_STATUS_TONES = {
  outline: "neutral",
  warning: "attention",
  success: "positive",
} as const satisfies Record<ReturnType<typeof resolveCredentialBadge>["variant"], StatusTone>;

/**
 * The credential this connection signs with today, the one the last rotation retired while it
 * can still be restored, and who else signs with it.
 *
 * `managedHere` decides most of what it shows: a deployment-supplied credential has no version
 * SDP can track and nothing here can replace it, so it says where it is managed instead.
 */
function CredentialRows({
  canAct,
  connectionId,
  lifecycle,
  managedHere,
  pending,
  t,
}: {
  canAct: boolean;
  connectionId: string;
  lifecycle: CustodyCredentialLifecycle;
  managedHere: boolean;
  pending: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const formatDate = useDateFormatter();
  const credential = lifecycle.providerCredential;
  const badge = resolveCredentialBadge(credential, t);
  const otherConnections = lifecycle.impact.connections.filter(({ id }) => id !== connectionId);
  const rollbackState = canRollBack(lifecycle);
  const rotationBlocksRollback =
    rollbackState.available === false && rollbackState.reason === "rotation_pending";

  return (
    <dl>
      {managedHere ? null : (
        <RecordLine label={t("DashboardCustody.credentialManagedIn")}>
          {t("DashboardCustody.credentialDeploymentBadge")}
        </RecordLine>
      )}
      <RecordLine
        label={t(
          credential.provider === "fireblocks"
            ? "DashboardCustody.providerFireblocksApiKey"
            : "DashboardCustody.credentialAppId"
        )}
      >
        <span className="font-mono">{maskedCredentialId(credential)}</span>
      </RecordLine>
      {credential.status === "active" ? null : (
        <RecordLine label={t("DashboardCustody.status")}>
          <StatusText tone={CREDENTIAL_STATUS_TONES[badge.variant]}>{badge.label}</StatusText>
        </RecordLine>
      )}
      {managedHere ? (
        <RecordLine
          label={t(
            credential.provider === "fireblocks"
              ? "DashboardCustody.credentialSecret"
              : "DashboardCustody.providerPrivyAppSecret"
          )}
        >
          {t("DashboardCustody.credentialInUseSinceValue", {
            date: formatDate(credential.createdAt) ?? "—",
          })}
        </RecordLine>
      ) : (
        <RecordLine label={t("DashboardCustody.credentialVersion")}>
          {t("DashboardCustody.credentialVersionUntracked")}
        </RecordLine>
      )}
      {managedHere && otherConnections.length > 0 ? (
        <RecordLine label={t("DashboardCustody.credentialAlsoUsedBy")}>
          {t("DashboardCustody.credentialAlsoUsedByValue", {
            count: otherConnections.length,
            projects: new Set(otherConnections.map(({ projectId }) => projectId)).size,
          })}
        </RecordLine>
      ) : null}
      {lifecycle.rollback ? (
        <RecordLine label={t("DashboardCustody.credentialPreviousSecret")}>
          <span>
            {t("DashboardCustody.credentialPreviousSecretRestorable", {
              hours: rollbackHoursRemaining(lifecycle.rollback.expiresAt),
              date: formatDate(lifecycle.rollback.expiresAt) ?? "—",
            })}
          </span>
          {rotationBlocksRollback && canAct && !pending ? (
            <span className="text-warning">{t("DashboardCustody.rollbackBlockedByRotation")}</span>
          ) : null}
        </RecordLine>
      ) : null}
    </dl>
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

/** The block's frame, for the two states that have no credential to show. */
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
    <RecordBlock title={title}>
      <Callout variant={variant}>{message}</Callout>
    </RecordBlock>
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
 * Derives what the viewer can do to these credentials from the lifecycle and
 * the custody permission.
 *
 * A restricted or failed read has no lifecycle, so it permits nothing.
 */
export function resolveCredentialActions(
  lifecycle: CustodyCredentialLifecycle | "restricted" | null,
  canManageCustody: boolean
) {
  const availableLifecycle = typeof lifecycle === "object" ? lifecycle : null;
  if (availableLifecycle === null) {
    return {
      availableLifecycle,
      managedHere: false,
      currentInUse: false,
      canAct: false,
      canDeactivate: false,
    };
  }

  const credential = availableLifecycle.providerCredential;
  const managedHere = isCredentialManagedHere(credential);
  const currentInUse =
    credential.status === "active" && availableLifecycle.impact.connections.length > 0;
  const canManageHere = canManageCustody && managedHere;
  return {
    availableLifecycle,
    managedHere,
    currentInUse,
    canAct: canManageHere && currentInUse,
    canDeactivate:
      canManageHere && (credential.status === "active" || credential.status === "pending"),
  };
}

/**
 * A rotation the page has started, held above the block so the header's Rotate secret and the
 * block share it. `lifecycle` stays set across dismissal and refresh so an unresolved rotation
 * resumes with the original payload, key and credential target.
 */
export interface RotationState {
  lifecycle: CustodyCredentialLifecycle | null;
  open: boolean;
}

/**
 * The lifecycle a new rotation would start from, or `null` while one cannot start: the viewer
 * cannot act on these credentials (which also rules out any credential that is not active and
 * in use), a candidate is still waiting, or the page already holds a rotation.
 */
export function rotatableLifecycle(
  lifecycle: CustodyCredentialLifecycle | "restricted" | null,
  canManageCustody: boolean,
  rotation: RotationState
): CustodyCredentialLifecycle | null {
  const { availableLifecycle, canAct } = resolveCredentialActions(lifecycle, canManageCustody);
  if (!availableLifecycle || !canAct || availableLifecycle.rotationCandidate) return null;
  return rotation.lifecycle === null ? availableLifecycle : null;
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
  rotation,
  onRotationChange,
}: {
  lifecycle: CustodyCredentialLifecycle | "restricted" | null;
  connection: CustodyInstallationConnection;
  provider: CustodyProvider;
  canManageCustody: boolean;
  rotation: RotationState;
  onRotationChange: (rotation: RotationState) => void;
}) {
  const t = useTranslations();
  const { pending, run } = useCustodyAction();
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const { availableLifecycle, managedHere, currentInUse, canAct } = resolveCredentialActions(
    lifecycle,
    canManageCustody
  );
  const rotationModal = rotation.lifecycle ? (
    <>
      <RotateCredentialsModal
        isOpen={rotation.open}
        onClose={(preserveAttempt) =>
          onRotationChange({
            lifecycle: preserveAttempt ? rotation.lifecycle : null,
            open: false,
          })
        }
        lifecycle={availableLifecycle ?? rotation.lifecycle}
        provider={provider}
        connectionId={connection.id}
        canRotate={canAct}
      />
      {!rotation.open ? (
        <Callout variant="warning" title={t("DashboardCustody.rotateUnknownTitle")}>
          <p>{t("DashboardCustody.rotateResumeHint")}</p>
          <Button
            className="mt-3"
            size="sm"
            variant="secondary"
            onClick={() => onRotationChange({ lifecycle: rotation.lifecycle, open: true })}
          >
            {t("DashboardCustody.rotateResumeAction")}
          </Button>
        </Callout>
      ) : null}
    </>
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
  const rollbackAvailable = canAct && canRollBack(lifecycle).available && !pending;

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
      <RecordBlock
        title={t("DashboardCustody.credentialsTitle")}
        hint={t("DashboardCustody.credentialsHint")}
        aside={
          lifecycle.rollback && canAct ? (
            <Button
              variant="outline"
              size="sm"
              disabled={!rollbackAvailable}
              onClick={() => setRollbackOpen(true)}
            >
              {t("DashboardCustody.rollbackSecretAction")}
            </Button>
          ) : null
        }
      >
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

        {managedHere ? null : (
          <Callout variant="neutral">{t("DashboardCustody.credentialDeploymentExplainer")}</Callout>
        )}

        <CredentialRows
          canAct={canAct}
          connectionId={connection.id}
          lifecycle={lifecycle}
          managedHere={managedHere}
          pending={pending}
          t={t}
        />

        {credential.status === "deactivated" ? (
          <p className="text-body text-tertiary">
            {t("DashboardCustody.deactivateCredentialsSuccessDescription")}
          </p>
        ) : null}
        {managedHere &&
        credential.status === "active" &&
        lifecycle.impact.connections.length === 0 ? (
          <p className="text-body text-tertiary">{t("DashboardCustody.credentialNoLongerUsed")}</p>
        ) : null}
        {canAct ? (
          <RollbackDialog
            isOpen={rollbackOpen}
            onClose={() => setRollbackOpen(false)}
            lifecycle={lifecycle}
            provider={provider}
            connectionId={connection.id}
          />
        ) : null}
      </RecordBlock>
    </>
  );
}
