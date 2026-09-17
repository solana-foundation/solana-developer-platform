"use client";

import { RefreshCwIcon } from "lucide-react";
import { WalletMetadataCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
import { docsHref } from "@/components/dashboard-nav";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { useTranslations } from "@/i18n/provider";
import type { CustodyOutcome, CustodyOutcomeKind } from "./verification-outcome";

type Translate = ReturnType<typeof useTranslations>;

/**
 * Written as switches rather than lookup maps so the catalog keys stay string
 * literals: `useTranslations` only accepts keys that exist in the English
 * catalog, and a map widens them to `string`, which would cast that check away.
 */
function outcomeTitle(kind: CustodyOutcomeKind, t: Translate): string {
  switch (kind) {
    case "invalid_credentials":
      return t("DashboardCustody.outcomeInvalidTitle");
    case "account_mismatch":
      return t("DashboardCustody.outcomeMismatchTitle");
    case "temporary":
      return t("DashboardCustody.outcomeTemporaryTitle");
    case "conflict":
      return t("DashboardCustody.outcomeConflictTitle");
    case "unknown":
      return t("DashboardCustody.outcomeUnknownTitle");
    case "wallet_conflict":
      return t("DashboardCustody.outcomeWalletConflictTitle");
  }
}

function outcomeBody(kind: CustodyOutcomeKind, t: Translate): string {
  switch (kind) {
    case "invalid_credentials":
      return t("DashboardCustody.outcomeInvalidBody");
    case "account_mismatch":
      return t("DashboardCustody.outcomeMismatchBody");
    case "temporary":
      return t("DashboardCustody.outcomeTemporaryBody");
    case "conflict":
      return t("DashboardCustody.outcomeConflictBody");
    case "unknown":
      return t("DashboardCustody.outcomeUnknownBody");
    case "wallet_conflict":
      return t("DashboardCustody.outcomeWalletConflictBody");
  }
}

function recheckLabel(kind: CustodyOutcomeKind, t: Translate): string {
  switch (kind) {
    case "conflict":
      return t("DashboardCustody.outcomeReload");
    case "unknown":
      return t("DashboardCustody.outcomeCheckCurrentState");
    default:
      return t("DashboardCustody.byokCheckAgain");
  }
}

/**
 * Why the last credential check ended the way it did, and what to do next.
 *
 * This is the *only* callout an unfinished connection gets. It used to sit
 * under a second one that announced the setup was unfinished and offered its
 * own re-check: two banners, overlapping words, and two buttons doing one
 * thing. The diagnosis here is the more specific of the two, so it absorbed the
 * other one's actions instead of being stacked under it.
 *
 * The tone carries as much meaning as the text. A temporary transport problem
 * is blue, a concurrent change amber, and an outcome nobody could confirm is
 * plain — never red, because red asserts a failure that has not been
 * established and invites the user to redo work that may already be done.
 *
 * The wallet-conflict case offers no retry at all. Replacing the credentials
 * cannot reconcile the wallet, so a retry button would only loop; what helps is
 * the connection id and a way to reach support.
 */
export function VerificationOutcomeCallout({
  outcome,
  connectionId,
  onRecheck,
  rechecking = false,
  onCancelSetup,
}: {
  outcome: CustodyOutcome;
  connectionId: string;
  /**
   * Continue this same setup. Withheld when the API says the connection cannot
   * be continued, or the viewer may not act — the caller owns both answers, so
   * the presence of the handler is what decides whether the control appears.
   */
  onRecheck?: () => void;
  rechecking?: boolean;
  /** Abandon the setup instead, withheld on the same terms. */
  onCancelSetup?: () => void;
}) {
  const t = useTranslations();

  return (
    <Callout
      live
      variant={outcome.tone}
      title={outcomeTitle(outcome.kind, t)}
      data-outcome={outcome.kind}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p>{outcomeBody(outcome.kind, t)}</p>
        <span className="flex shrink-0 items-center gap-2">
          {/* `retryable` excludes the one outcome no amount of re-checking can
              settle; everything else is the caller's call. */}
          {onRecheck && outcome.retryable ? (
            <Button
              size="sm"
              onClick={onRecheck}
              disabled={rechecking}
              iconLeft={<RefreshCwIcon className="size-4" />}
            >
              {recheckLabel(outcome.kind, t)}
            </Button>
          ) : null}
          {onCancelSetup ? (
            <Button size="sm" variant="secondary" onClick={onCancelSetup} disabled={rechecking}>
              {t("DashboardCustody.cancelSetupAction")}
            </Button>
          ) : null}
          {outcome.kind === "wallet_conflict" ? (
            <>
              <span className="flex items-center gap-1 text-xs">
                <span className="font-mono">{connectionId}</span>
                <WalletMetadataCopyButton
                  value={connectionId}
                  label={t("DashboardCustody.connectionIdLabel")}
                  tooltip={connectionId}
                />
              </span>
              <Button size="sm" variant="secondary" asChild>
                <a href={docsHref} target="_blank" rel="noreferrer noopener">
                  {t("DashboardCustody.outcomeContactSupport")}
                </a>
              </Button>
            </>
          ) : null}
        </span>
      </div>
    </Callout>
  );
}
