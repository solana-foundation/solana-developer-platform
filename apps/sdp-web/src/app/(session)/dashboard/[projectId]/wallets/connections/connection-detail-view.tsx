"use client";

import type { CustodyProvider, CustodyWalletSummary } from "@sdp/types/custody";
import { Badge } from "@sdp/ui/badge";
import { Button } from "@sdp/ui/button";
import { Callout } from "@sdp/ui/callout";
import { cn } from "@sdp/ui/cn";
import { ChevronDownIcon, RefreshCwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useMemo, useState, useTransition } from "react";
import { recheckPrivyCredentialAction } from "@/app/(session)/dashboard/[projectId]/wallets/byok-actions";
import { WalletMetadataCopyButton } from "@/app/(session)/dashboard/[projectId]/wallets/wallet-address-copy-button";
import { formatCreatedDate } from "@/app/(session)/dashboard/[projectId]/wallets/wallet-format-utils";
import { DashboardPageTitle } from "@/components/dashboard-page-title";
import { EntityLink } from "@/components/entity-link";
import { RecordBlock, RecordLine, RecordStack } from "@/components/refresh-record";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useTimeZone } from "@/i18n/time-zone";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { AddWalletDialog } from "./add-wallet-dialog";
import { CancelSetupDialog } from "./cancel-setup-dialog";
import {
  ConnectionCredentialsSection,
  type RotationState,
  resolveCredentialActions,
  rotatableLifecycle,
} from "./connection-credentials-section";
import type {
  CustodyCredentialLifecycle,
  CustodyInstallationConnection,
} from "./connection-detail.data";
import { STATUS_BADGE_VARIANTS, statusLabel } from "./connection-status-presentation";
import { ConnectionWalletsCard } from "./connection-wallets-card";
import type { CustodyConnectionListItem } from "./connections.data";
import { DeactivateConnectionDialog } from "./deactivate-connection-dialog";
import { DeactivateCredentialsDialog } from "./deactivate-credentials-dialog";
import { useSelectedProjectName } from "./use-selected-project-name";
import { resolveCompletionOutcome } from "./verification-outcome";
import { VerificationOutcomeCallout } from "./verification-outcome-callout";

/**
 * An install that never finished, and the two ways out of it.
 *
 * Checking again continues the *same* connection rather than starting a second
 * one — the completion is replay-safe server-side — which is why the button is
 * offered at all rather than sending the user back to Add connection. Each
 * action appears only when the API says it applies.
 */
function UnfinishedSetupCallout({
  canCancel,
  canComplete,
  canManageCustody,
  onCancelSetup,
  onRecheck,
  rechecking,
  t,
}: {
  canCancel: boolean;
  canComplete: boolean;
  canManageCustody: boolean;
  onCancelSetup: () => void;
  onRecheck: () => void;
  rechecking: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <Callout variant="warning" title={t("DashboardCustody.setupUnfinishedTitle")}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p>{t("DashboardCustody.setupUnfinishedBody")}</p>
        {canManageCustody ? (
          <span className="flex shrink-0 items-center gap-2">
            {canComplete ? (
              <Button
                size="sm"
                onClick={onRecheck}
                disabled={rechecking}
                iconLeft={<RefreshCwIcon className="size-4" />}
              >
                {t("DashboardCustody.byokCheckAgain")}
              </Button>
            ) : null}
            {canCancel ? (
              <Button size="sm" variant="secondary" onClick={onCancelSetup}>
                {t("DashboardCustody.cancelSetupAction")}
              </Button>
            ) : null}
          </span>
        ) : null}
      </div>
    </Callout>
  );
}

/** One irreversible action: what it does on the left, its control on the right. */
function DangerRow({
  title,
  body,
  control,
  children,
}: {
  title: string;
  body: string;
  control: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-border-subtle py-4 first:pt-0 last:border-b-0 last:pb-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <p className="text-field font-medium text-primary">{title}</p>
          <p className="text-body text-secondary">{body}</p>
        </div>
        {control ? <div className="shrink-0">{control}</div> : null}
      </div>
      {children}
    </div>
  );
}

/**
 * Ending the connection, or the credentials behind it, for good.
 *
 * Active wallets block deactivating the connection, so instead of a button that would only be
 * refused the row says how many and lists them, each a link to the wallet whose page can move
 * or retire it. `null` hides a row the connection's state rules out.
 */
function DangerZone({
  connectionRow,
  onDeactivateCredentials,
  t,
}: {
  connectionRow: {
    activeWallets: CustodyWalletSummary[];
    canManageCustody: boolean;
    isUnfinished: boolean;
    onDeactivate: () => void;
  } | null;
  onDeactivateCredentials: (() => void) | null;
  t: ReturnType<typeof useTranslations>;
}) {
  const href = useProjectHref();
  const [walletsShown, setWalletsShown] = useState(false);
  const activeWallets = connectionRow?.activeWallets ?? [];
  const blockingWallets = activeWallets.length;

  const connectionControl =
    !connectionRow || connectionRow.isUnfinished ? null : blockingWallets > 0 ? (
      <button
        type="button"
        aria-expanded={walletsShown}
        onClick={() => setWalletsShown((shown) => !shown)}
        className="inline-flex items-center gap-1.5 text-field text-primary"
      >
        {blockingWallets === 1
          ? t("DashboardCustody.walletsStillActiveOne")
          : t("DashboardCustody.walletsStillActive", { count: blockingWallets })}
        <ChevronDownIcon
          aria-hidden
          className={cn("size-4 text-tertiary transition-transform", walletsShown && "rotate-180")}
        />
      </button>
    ) : connectionRow.canManageCustody ? (
      <Button variant="destructive" size="sm" onClick={connectionRow.onDeactivate}>
        {t("DashboardCustody.deactivateConnectionConfirm")}
      </Button>
    ) : null;

  return (
    <RecordBlock title={t("DashboardCustody.dangerZoneTitle")}>
      <div>
        {connectionRow ? (
          <DangerRow
            title={t("DashboardCustody.deactivateConnectionSectionTitle")}
            body={
              connectionRow.isUnfinished
                ? t("DashboardCustody.deactivateNotApplicableUnfinished")
                : t("DashboardCustody.deactivateConnectionSectionBody")
            }
            control={connectionControl}
          >
            {walletsShown && blockingWallets > 0 ? (
              <ul className="space-y-2 pt-1">
                {activeWallets.map((wallet) => (
                  <li key={wallet.walletId} className="text-body">
                    <EntityLink
                      href={href(`/dashboard/wallets/${encodeURIComponent(wallet.walletId)}`)}
                    >
                      {wallet.label?.trim() || wallet.walletId}
                    </EntityLink>
                  </li>
                ))}
              </ul>
            ) : null}
          </DangerRow>
        ) : null}
        {onDeactivateCredentials ? (
          <DangerRow
            title={t("DashboardCustody.deactivateCredentialsConfirm")}
            body={t("DashboardCustody.deactivateCredentialsRowBody")}
            control={
              <Button variant="destructive" size="sm" onClick={onDeactivateCredentials}>
                {t("DashboardCustody.deactivateCredentialsConfirm")}
              </Button>
            }
          />
        ) : null}
      </div>
    </RecordBlock>
  );
}

function ConnectionDetails({
  connection,
  listItem,
  projectName,
  t,
}: {
  connection: CustodyInstallationConnection;
  listItem: CustodyConnectionListItem | null;
  projectName: string | null;
  t: ReturnType<typeof useTranslations>;
}) {
  const locale = useLocale();
  const timeZone = useTimeZone();
  return (
    <RecordBlock title={t("DashboardCustody.connectionDetailsTitle")}>
      <dl>
        <RecordLine label={t("DashboardCustody.connectionIdLabel")}>
          <span className="min-w-0 truncate">{connection.id}</span>
          <span className="-my-1.5 ml-auto">
            <WalletMetadataCopyButton
              value={connection.id}
              label={t("DashboardCustody.connectionIdLabel")}
              tooltip={connection.id}
            />
          </span>
        </RecordLine>
        {projectName ? (
          <RecordLine label={t("DashboardCustody.project")}>{projectName}</RecordLine>
        ) : null}
        {listItem ? (
          <RecordLine label={t("DashboardCustody.created")}>
            {formatCreatedDate(listItem.createdAt, locale, timeZone)}
          </RecordLine>
        ) : null}
      </dl>
    </RecordBlock>
  );
}

/**
 * The one banner an unsettled connection gets.
 *
 * Which of the two it is, and whether it carries any action, is decided here
 * rather than on the page: the outcome is the specific diagnosis and the
 * unfinished state the generic one, and they were once rendered together —
 * overlapping words, two buttons re-running the same check.
 */
function SetupStateBanner({
  canManageCustody,
  connection,
  onCancelSetup,
  onRecheck,
  rechecking,
  t,
}: {
  canManageCustody: boolean;
  connection: CustodyInstallationConnection;
  onCancelSetup: () => void;
  onRecheck: () => void;
  rechecking: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const outcome = resolveCompletionOutcome(connection.completion);

  if (outcome) {
    return (
      <VerificationOutcomeCallout
        outcome={outcome}
        connectionId={connection.id}
        onRecheck={canManageCustody && connection.canComplete ? onRecheck : undefined}
        rechecking={rechecking}
        onCancelSetup={canManageCustody && connection.canCancel ? onCancelSetup : undefined}
      />
    );
  }

  if (connection.status === "pending" || connection.status === "failed") {
    return (
      <UnfinishedSetupCallout
        canCancel={connection.canCancel}
        canComplete={connection.canComplete}
        canManageCustody={canManageCustody}
        onCancelSetup={onCancelSetup}
        onRecheck={onRecheck}
        rechecking={rechecking}
        t={t}
      />
    );
  }

  return null;
}

/** Which dialog, if any, the page is showing. */
type DialogName = "addWallet" | "deactivate" | "deactivateCredentials" | "cancelSetup" | null;

/** Every dialog the page can open, each deciding for itself when it is visible. */
function ConnectionDialogs({
  activeWalletCount,
  connection,
  credentialLifecycle,
  open,
  onClose,
  projectName,
  provider,
}: {
  activeWalletCount: number;
  connection: CustodyInstallationConnection;
  /** The credentials the viewer may deactivate, or `null` when they may not. */
  credentialLifecycle: CustodyCredentialLifecycle | null;
  open: DialogName;
  onClose: () => void;
  projectName: string;
  provider: CustodyProvider;
}) {
  return (
    <>
      <AddWalletDialog
        isOpen={open === "addWallet"}
        onClose={onClose}
        connectionId={connection.id}
        connectionLabel={connection.label}
        provider={provider}
        projectName={projectName}
      />
      <DeactivateConnectionDialog
        isOpen={open === "deactivate"}
        onClose={onClose}
        connectionId={connection.id}
        label={connection.label}
        provider={provider}
        activeWalletCount={activeWalletCount}
      />
      {credentialLifecycle ? (
        <DeactivateCredentialsDialog
          isOpen={open === "deactivateCredentials"}
          onClose={onClose}
          lifecycle={credentialLifecycle}
          provider={provider}
          connectionId={connection.id}
        />
      ) : null}
      <CancelSetupDialog
        isOpen={open === "cancelSetup"}
        onClose={onClose}
        connectionId={connection.id}
        label={connection.label}
        provider={provider}
      />
    </>
  );
}

/**
 * Everything one custody connection is and everything that can be done to it,
 * on one scrolling page.
 *
 * The page reads its whole state from the server on every load, which is what
 * makes it reload-safe: an install interrupted halfway comes back with the same
 * next step offered, and no recovery state is stranded in component memory.
 *
 * Which controls appear is decided by the API's own answers — `canComplete`,
 * `canCancel`, the credential's `source`, whether a rollback target is still
 * live — rather than by re-deriving the rules here. Where a control is withheld
 * the reason is stated next to it.
 */
export function ConnectionDetailView({
  connection,
  listItem,
  lifecycle,
  wallets,
  walletsUnavailable,
  provider,
  canManageCustody,
}: {
  connection: CustodyInstallationConnection;
  listItem: CustodyConnectionListItem | null;
  lifecycle: CustodyCredentialLifecycle | "restricted" | null;
  wallets: CustodyWalletSummary[];
  walletsUnavailable: boolean;
  provider: CustodyProvider;
  canManageCustody: boolean;
}) {
  const t = useTranslations();
  const router = useRouter();
  const projectName = useSelectedProjectName();
  // One dialog at a time by construction: opening any of them closes the rest,
  // which is what a modal surface means anyway.
  const [openDialog, setOpenDialog] = useState<DialogName>(null);
  const [rechecking, startRecheck] = useTransition();
  const [rotation, setRotation] = useState<RotationState>({ lifecycle: null, open: false });

  const isDeactivated = connection.status === "deactivated";
  const isUnfinished = connection.status === "pending" || connection.status === "failed";
  const activeWallets = wallets.filter((wallet) => wallet.status === "active");
  const signingPaused =
    listItem !== null && connection.status === "active" && !listItem.isRuntimeExecutionAllowed;
  const rotatable = rotatableLifecycle(lifecycle, canManageCustody, rotation);
  const credentialActions = resolveCredentialActions(lifecycle, canManageCustody);
  const deactivatableCredentials = credentialActions.canDeactivate
    ? credentialActions.availableLifecycle
    : null;

  // Stable elements, so the shell's header is set once per state rather than every render.
  const badge = useMemo(
    () => (
      <Badge variant={STATUS_BADGE_VARIANTS[connection.status]}>
        {statusLabel(connection.status, t)}
      </Badge>
    ),
    [connection.status, t]
  );
  const actions = useMemo(
    () =>
      rotatable ? (
        <Button
          variant="outline"
          onClick={() => setRotation({ lifecycle: rotatable, open: true })}
          iconLeft={<RefreshCwIcon className="size-4" />}
        >
          {t("DashboardCustody.rotateSecretAction")}
        </Button>
      ) : undefined,
    [rotatable, t]
  );

  const handleRecheck = () => {
    startRecheck(async () => {
      try {
        await recheckPrivyCredentialAction(connection.id);
      } catch {
        // The completion is replay-safe and the connection survives
        // server-side, so a lost response leaves the offered step valid.
      }
      router.refresh();
    });
  };

  return (
    <div className="@container w-full" data-custody-connection={connection.id}>
      <DashboardPageTitle title={connection.label} badge={badge} actions={actions} />
      <RecordStack spacing="loose">
        <div className="flex flex-col gap-3 empty:hidden">
          {isDeactivated ? (
            <Callout variant="neutral">
              {t("DashboardCustody.connectionDeactivatedExplainer")}
            </Callout>
          ) : (
            <SetupStateBanner
              canManageCustody={canManageCustody}
              connection={connection}
              onCancelSetup={() => setOpenDialog("cancelSetup")}
              onRecheck={handleRecheck}
              rechecking={rechecking}
              t={t}
            />
          )}
          {signingPaused ? (
            <Callout variant="warning">{t("DashboardCustody.connectionSigningPaused")}</Callout>
          ) : null}
        </div>

        <ConnectionWalletsCard
          wallets={wallets}
          walletsUnavailable={walletsUnavailable}
          isDeactivated={isDeactivated}
          pendingWalletLabel={connection.walletLabel ?? null}
          provider={provider}
          onAddWallet={
            canManageCustody && connection.status === "active"
              ? () => setOpenDialog("addWallet")
              : null
          }
        />

        <ConnectionCredentialsSection
          lifecycle={lifecycle}
          connection={connection}
          provider={provider}
          canManageCustody={canManageCustody}
          rotation={rotation}
          onRotationChange={setRotation}
        />

        <ConnectionDetails
          connection={connection}
          listItem={listItem}
          projectName={projectName}
          t={t}
        />

        {isDeactivated && !deactivatableCredentials ? null : (
          <DangerZone
            connectionRow={
              isDeactivated
                ? null
                : {
                    activeWallets,
                    canManageCustody,
                    isUnfinished,
                    onDeactivate: () => setOpenDialog("deactivate"),
                  }
            }
            onDeactivateCredentials={
              deactivatableCredentials ? () => setOpenDialog("deactivateCredentials") : null
            }
            t={t}
          />
        )}
      </RecordStack>

      <ConnectionDialogs
        activeWalletCount={activeWallets.length}
        connection={connection}
        credentialLifecycle={deactivatableCredentials}
        open={openDialog}
        onClose={() => setOpenDialog(null)}
        projectName={projectName}
        provider={provider}
      />
    </div>
  );
}
