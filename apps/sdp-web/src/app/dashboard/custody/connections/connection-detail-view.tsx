"use client";

import type { CustodyProvider, CustodyWalletSummary } from "@sdp/types";
import { PlusIcon, RefreshCwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { recheckPrivyCredentialAction } from "@/app/dashboard/custody/byok-actions";
import { formatCustodyProviderName } from "@/app/dashboard/custody/provider-catalog";
import { WalletMetadataCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
import { formatCreatedDate } from "@/app/dashboard/custody/wallet-format-utils";
import { WalletProviderMark } from "@/app/dashboard/custody/wallet-provider-mark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { useLocale, useTranslations } from "@/i18n/provider";
import { AddWalletDialog } from "./add-wallet-dialog";
import { CancelSetupDialog } from "./cancel-setup-dialog";
import { ConnectionCredentialsSection } from "./connection-credentials-section";
import type {
  CustodyCredentialLifecycle,
  CustodyInstallationConnection,
} from "./connection-detail.data";
import { SigningLine } from "./connection-status";
import { STATUS_BADGE_VARIANTS, statusLabel } from "./connection-status-presentation";
import { ConnectionWalletsCard } from "./connection-wallets-card";
import type { CustodyConnectionListItem } from "./connections.data";
import { DeactivateConnectionDialog } from "./deactivate-connection-dialog";
import { MakeDefaultDialog } from "./make-default-dialog";
import { useSelectedProjectName } from "./use-selected-project-name";
import { resolveCompletionOutcome } from "./verification-outcome";
import { VerificationOutcomeCallout } from "./verification-outcome-callout";

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
      <dt className="w-32 shrink-0 text-tertiary">{label}</dt>
      <dd className="min-w-0 text-primary">{children}</dd>
    </div>
  );
}

/**
 * Identity of the connection, plus the two actions that apply to it as a whole.
 *
 * Signing availability sits on its own line under the badges rather than
 * becoming a third one: connection health and whether it may sign right now are
 * different facts, and collapsing them into one row would hide that.
 */
function ConnectionHeaderCard({
  canManageCustody,
  connection,
  listItem,
  onAddWallet,
  onMakeDefault,
  projectName,
  provider,
  t,
}: {
  canManageCustody: boolean;
  connection: CustodyInstallationConnection;
  listItem: CustodyConnectionListItem | null;
  onAddWallet: () => void;
  onMakeDefault: () => void;
  projectName: string | null;
  provider: CustodyProvider;
  t: ReturnType<typeof useTranslations>;
}) {
  const locale = useLocale();
  const formattedCreated = listItem ? formatCreatedDate(listItem.createdAt, locale) : null;

  return (
    <header className="rounded-2xl border border-border-default bg-surface-raised p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-fill-strong">
            <WalletProviderMark provider={provider} size="sm" />
          </span>
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-medium tracking-tight text-primary">
                {connection.label}
              </h1>
              <Badge variant={STATUS_BADGE_VARIANTS[connection.status]}>
                {statusLabel(connection.status, t)}
              </Badge>
              {connection.isDefault ? (
                <Badge variant="outline">{t("DashboardCustody.projectDefaultBadge")}</Badge>
              ) : null}
            </div>
            {listItem ? (
              <SigningLine
                status={connection.status}
                isRuntimeExecutionAllowed={listItem.isRuntimeExecutionAllowed}
              />
            ) : null}
            <dl className="space-y-1 pt-1">
              <DetailRow label={t("DashboardCustody.provider")}>
                {formatCustodyProviderName(provider)}
              </DetailRow>
              {projectName ? (
                <DetailRow label={t("DashboardCustody.project")}>{projectName}</DetailRow>
              ) : null}
              <DetailRow label={t("DashboardCustody.connectionIdLabel")}>
                <span className="flex min-w-0 items-center gap-1">
                  <span className="truncate font-mono text-xs">{connection.id}</span>
                  <WalletMetadataCopyButton
                    value={connection.id}
                    label={t("DashboardCustody.connectionIdLabel")}
                    tooltip={connection.id}
                  />
                </span>
              </DetailRow>
              {formattedCreated ? (
                <DetailRow label={t("DashboardCustody.created")}>{formattedCreated}</DetailRow>
              ) : null}
            </dl>
          </div>
        </div>

        {/* Nothing is actionable on a connection that has been ended, and a
            half-finished one has exactly one next step, offered below. */}
        {canManageCustody && connection.status === "active" ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button variant="secondary" disabled={connection.isDefault} onClick={onMakeDefault}>
              {t("DashboardCustody.makeDefaultAction")}
            </Button>
            <Button onClick={onAddWallet} iconLeft={<PlusIcon className="size-4" />}>
              {t("DashboardCustody.addWalletAction")}
            </Button>
          </div>
        ) : null}
      </div>
    </header>
  );
}

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

/**
 * Ending the connection for good.
 *
 * The button stays enabled even when deactivation would be refused, because the
 * dialog behind it is where the refusal is explained — a disabled control
 * cannot open the thing that would tell you why it is disabled. The inline line
 * above it is the at-a-glance version of the same reason.
 */
function DeactivateConnectionCard({
  activeWalletCount,
  canManageCustody,
  isUnfinished,
  onDeactivate,
  t,
}: {
  activeWalletCount: number;
  canManageCustody: boolean;
  isUnfinished: boolean;
  onDeactivate: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const blockingReason = isUnfinished
    ? t("DashboardCustody.deactivateNotApplicableUnfinished")
    : activeWalletCount > 0
      ? t("DashboardCustody.deactivateBlockedByWallets", { count: activeWalletCount })
      : null;

  return (
    <section className="rounded-2xl border border-border-default bg-surface-raised p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h2 className="text-base font-medium text-primary">
            {t("DashboardCustody.deactivateConnectionSectionTitle")}
          </h2>
          <p className="text-sm text-secondary">
            {t("DashboardCustody.deactivateConnectionSectionBody")}
          </p>
          {blockingReason ? <p className="text-sm text-warning">{blockingReason}</p> : null}
        </div>
        {canManageCustody && !isUnfinished ? (
          <Button variant="destructive" className="shrink-0" onClick={onDeactivate}>
            {t("DashboardCustody.deactivateConnectionConfirm")}
          </Button>
        ) : null}
      </div>
    </section>
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
type DialogName = "addWallet" | "makeDefault" | "deactivate" | "cancelSetup" | null;

/** Every dialog the page can open, each deciding for itself when it is visible. */
function ConnectionDialogs({
  activeWalletCount,
  connection,
  open,
  onClose,
  projectName,
  provider,
}: {
  activeWalletCount: number;
  connection: CustodyInstallationConnection;
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
      <MakeDefaultDialog
        isOpen={open === "makeDefault"}
        onClose={onClose}
        connectionId={connection.id}
        label={connection.label}
        provider={provider}
        projectName={projectName}
        // This page reads one connection, so it cannot see which of the others
        // is the project default. Saying "the project has no default today"
        // from here would be a guess; the dialog has copy for not knowing.
        currentDefaultLabel={null}
        currentDefaultKnown={false}
      />
      <DeactivateConnectionDialog
        isOpen={open === "deactivate"}
        onClose={onClose}
        connectionId={connection.id}
        label={connection.label}
        provider={provider}
        activeWalletCount={activeWalletCount}
        isDefault={connection.isDefault}
      />
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

  const isDeactivated = connection.status === "deactivated";
  const isUnfinished = connection.status === "pending" || connection.status === "failed";
  const activeWallets = wallets.filter((wallet) => wallet.status === "active");

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
    <div className="w-full space-y-6 px-4 py-6 md:px-6" data-custody-connection={connection.id}>
      <ConnectionHeaderCard
        canManageCustody={canManageCustody}
        connection={connection}
        listItem={listItem}
        onAddWallet={() => setOpenDialog("addWallet")}
        onMakeDefault={() => setOpenDialog("makeDefault")}
        projectName={projectName}
        provider={provider}
        t={t}
      />

      {isDeactivated ? (
        <Callout variant="neutral">{t("DashboardCustody.connectionDeactivatedExplainer")}</Callout>
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

      <ConnectionWalletsCard
        wallets={wallets}
        walletsUnavailable={walletsUnavailable}
        isDeactivated={isDeactivated}
        pendingWalletLabel={connection.walletLabel ?? null}
        defaultWalletId={listItem?.defaultCustodyWalletId ?? null}
      />

      <ConnectionCredentialsSection
        lifecycle={lifecycle}
        connection={connection}
        provider={provider}
        canManageCustody={canManageCustody}
      />

      {isDeactivated ? null : (
        <DeactivateConnectionCard
          activeWalletCount={activeWallets.length}
          canManageCustody={canManageCustody}
          isUnfinished={isUnfinished}
          onDeactivate={() => setOpenDialog("deactivate")}
          t={t}
        />
      )}

      <ConnectionDialogs
        activeWalletCount={activeWallets.length}
        connection={connection}
        open={openDialog}
        onClose={() => setOpenDialog(null)}
        projectName={projectName}
        provider={provider}
      />
    </div>
  );
}
