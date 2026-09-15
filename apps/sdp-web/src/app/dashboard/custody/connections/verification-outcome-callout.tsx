"use client";

import { RefreshCwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { recheckPrivyCredentialAction } from "@/app/dashboard/custody/byok-actions";
import { WalletMetadataCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { docsHref } from "@/components/dashboard-nav";
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

/**
 * Why the last credential check ended the way it did, and what to do next.
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
}: {
  outcome: CustodyOutcome;
  connectionId: string;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const recheck = () => {
    startTransition(async () => {
      try {
        await recheckPrivyCredentialAction(connectionId);
      } catch {
        // The completion is replay-safe: the connection survives server-side,
        // so a lost response leaves this same step valid.
      }
      router.refresh();
    });
  };

  const showRecheck =
    outcome.kind === "temporary" || outcome.kind === "unknown" || outcome.kind === "conflict";

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
          {showRecheck ? (
            <Button
              size="sm"
              onClick={recheck}
              disabled={pending}
              iconLeft={<RefreshCwIcon className="size-4" />}
            >
              {outcome.kind === "conflict"
                ? t("DashboardCustody.outcomeReload")
                : outcome.kind === "unknown"
                  ? t("DashboardCustody.outcomeCheckCurrentState")
                  : t("DashboardCustody.byokCheckAgain")}
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
