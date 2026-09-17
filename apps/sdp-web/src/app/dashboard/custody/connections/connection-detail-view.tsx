"use client";

import type { CustodyProvider, CustodyWalletSummary } from "@sdp/types";
import { PlusIcon, RefreshCwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { recheckPrivyCredentialAction } from "@/app/dashboard/custody/byok-actions";
import { formatCustodyProviderName } from "@/app/dashboard/custody/provider-catalog";
import { WalletMetadataCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
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
import { SigningLine, STATUS_BADGE_VARIANTS, statusLabel } from "./connection-status";
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
  formattedCreated,
  listItem,
  onAddWallet,
  onMakeDefault,
  projectName,
  provider,
  t,
}: {
  canManageCustody: boolean;
  connection: CustodyInstallationConnection;
  formattedCreated: string | null;
  listItem: CustodyConnectionListItem | null;
  onAddWallet: () => void;
  onMakeDefault: () => void;
  projectName: string | null;
  provider: CustodyProvider;
  t: ReturnType<typeof useTranslations>;
}) {
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
  const locale = useLocale();
  const router = useRouter();
  const projectName = useSelectedProjectName();
  const [addWalletOpen, setAddWalletOpen] = useState(false);
  const [makeDefaultOpen, setMakeDefaultOpen] = useState(false);
  const [deactivateOpen, setDeactivateOpen] = useState(false);
  const [cancelSetupOpen, setCancelSetupOpen] = useState(false);
  const [rechecking, startRecheck] = useTransition();

  const isDeactivated = connection.status === "deactivated";
  const isUnfinished = connection.status === "pending" || connection.status === "failed";
  const activeWallets = wallets.filter((wallet) => wallet.status === "active");
  const outcome = resolveCompletionOutcome(connection.completion);

  const createdAt = listItem?.createdAt ?? null;
  const formattedCreated = createdAt
    ? new Date(createdAt).toLocaleDateString(locale, {
        month: "short",
        day: "2-digit",
        year: "numeric",
      })
    : null;

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
        formattedCreated={formattedCreated}
        listItem={listItem}
        onAddWallet={() => setAddWalletOpen(true)}
        onMakeDefault={() => setMakeDefaultOpen(true)}
        projectName={projectName}
        provider={provider}
        t={t}
      />

      {isDeactivated ? (
        <Callout variant="neutral">{t("DashboardCustody.connectionDeactivatedExplainer")}</Callout>
      ) : null}

      {isUnfinished ? (
        <Callout variant="warning" title={t("DashboardCustody.setupUnfinishedTitle")}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p>{t("DashboardCustody.setupUnfinishedBody")}</p>
            {canManageCustody ? (
              <span className="flex shrink-0 items-center gap-2">
                {connection.canComplete ? (
                  <Button
                    size="sm"
                    onClick={handleRecheck}
                    disabled={rechecking}
                    iconLeft={<RefreshCwIcon className="size-4" />}
                  >
                    {t("DashboardCustody.byokCheckAgain")}
                  </Button>
                ) : null}
                {connection.canCancel ? (
                  <Button size="sm" variant="secondary" onClick={() => setCancelSetupOpen(true)}>
                    {t("DashboardCustody.cancelSetupAction")}
                  </Button>
                ) : null}
              </span>
            ) : null}
          </div>
        </Callout>
      ) : null}

      {outcome ? (
        <VerificationOutcomeCallout outcome={outcome} connectionId={connection.id} />
      ) : null}

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

      {!isDeactivated ? (
        <section className="rounded-2xl border border-border-default bg-surface-raised p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <h2 className="text-base font-medium text-primary">
                {t("DashboardCustody.deactivateConnectionSectionTitle")}
              </h2>
              <p className="text-sm text-secondary">
                {t("DashboardCustody.deactivateConnectionSectionBody")}
              </p>
              {isUnfinished ? (
                <p className="text-sm text-warning">
                  {t("DashboardCustody.deactivateNotApplicableUnfinished")}
                </p>
              ) : activeWallets.length > 0 ? (
                <p className="text-sm text-warning">
                  {t("DashboardCustody.deactivateBlockedByWallets", {
                    count: activeWallets.length,
                  })}
                </p>
              ) : null}
            </div>
            {canManageCustody && !isUnfinished ? (
              <Button
                variant="destructive"
                className="shrink-0"
                onClick={() => setDeactivateOpen(true)}
              >
                {t("DashboardCustody.deactivateConnectionConfirm")}
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}

      <AddWalletDialog
        isOpen={addWalletOpen}
        onClose={() => setAddWalletOpen(false)}
        connectionId={connection.id}
        connectionLabel={connection.label}
        provider={provider}
        projectName={projectName}
      />
      <MakeDefaultDialog
        isOpen={makeDefaultOpen}
        onClose={() => setMakeDefaultOpen(false)}
        connectionId={connection.id}
        label={connection.label}
        provider={provider}
        projectName={projectName}
        currentDefaultLabel={null}
      />
      <DeactivateConnectionDialog
        isOpen={deactivateOpen}
        onClose={() => setDeactivateOpen(false)}
        connectionId={connection.id}
        label={connection.label}
        provider={provider}
        activeWalletCount={activeWallets.length}
        isDefault={connection.isDefault}
      />
      <CancelSetupDialog
        isOpen={cancelSetupOpen}
        onClose={() => setCancelSetupOpen(false)}
        connectionId={connection.id}
        label={connection.label}
        provider={provider}
      />
    </div>
  );
}
