"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface TokenControlListsSectionProps {
  showControlList: boolean;
  controlListLabel: string | null;
  allowlistEntriesCount: number;
  allowlistError: string | null;
  allowlistTotal: number | null;
  allowlistHasMore: boolean;
  frozenAccountsCount: number;
  frozenAccountsError: string | null;
  frozenAccountsTotal: number | null;
  frozenAccountsHasMore: boolean;
}

export function TokenControlListsSection({
  showControlList,
  controlListLabel,
  allowlistEntriesCount,
  allowlistError,
  allowlistTotal,
  allowlistHasMore,
  frozenAccountsCount,
  frozenAccountsError,
  frozenAccountsTotal,
  frozenAccountsHasMore,
}: TokenControlListsSectionProps) {
  const controlListSummaryTitle = controlListLabel ? `${controlListLabel} Entries` : "Control List";
  const controlListDescription =
    showControlList && controlListLabel
      ? `${controlListLabel} entries and frozen account status`
      : "Frozen account status";

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>Control Lists</CardTitle>
        <CardDescription>{controlListDescription}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {showControlList ? (
          <div
            data-testid="allowlist-summary-card"
            className="rounded-xl border border-border-default p-3"
          >
            <p className="text-sm font-medium text-primary">{controlListSummaryTitle}</p>
            {allowlistError ? (
              <p className="mt-1 text-sm text-destructive-strongest">{allowlistError}</p>
            ) : (
              <>
                <p className="mt-1 text-sm text-secondary">
                  {(allowlistTotal ?? allowlistEntriesCount).toLocaleString("en-US")} entries
                </p>
                {allowlistHasMore ? (
                  <p className="mt-1 text-xs text-secondary">
                    Showing first {allowlistEntriesCount.toLocaleString("en-US")} entries.
                  </p>
                ) : null}
              </>
            )}
          </div>
        ) : null}
        <div
          data-testid="frozen-accounts-summary-card"
          className="rounded-xl border border-border-default p-3"
        >
          <p className="text-sm font-medium text-primary">Frozen Accounts</p>
          {frozenAccountsError ? (
            <p className="mt-1 text-sm text-destructive-strongest">{frozenAccountsError}</p>
          ) : (
            <>
              <p className="mt-1 text-sm text-secondary">
                {(frozenAccountsTotal ?? frozenAccountsCount).toLocaleString("en-US")} accounts
              </p>
              {frozenAccountsHasMore ? (
                <p className="mt-1 text-xs text-secondary">
                  Showing first {frozenAccountsCount.toLocaleString("en-US")} accounts.
                </p>
              ) : null}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
