"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface TokenControlListsSectionProps {
  showAllowlist: boolean;
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
  showAllowlist,
  allowlistEntriesCount,
  allowlistError,
  allowlistTotal,
  allowlistHasMore,
  frozenAccountsCount,
  frozenAccountsError,
  frozenAccountsTotal,
  frozenAccountsHasMore,
}: TokenControlListsSectionProps) {
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>Control Lists</CardTitle>
        <CardDescription>
          {showAllowlist ? "Allowlist entries and frozen account status" : "Frozen account status"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {showAllowlist ? (
          <div className="rounded-xl border border-[rgba(28,28,29,0.12)] p-3">
            <p className="text-sm font-medium text-[#1c1c1d]">Allowlist Entries</p>
            {allowlistError ? (
              <p className="mt-1 text-sm text-[#8a1f2a]">{allowlistError}</p>
            ) : (
              <>
                <p className="mt-1 text-sm text-[rgba(28,28,29,0.66)]">
                  {(allowlistTotal ?? allowlistEntriesCount).toLocaleString("en-US")} entries
                </p>
                {allowlistHasMore ? (
                  <p className="mt-1 text-xs text-[rgba(28,28,29,0.62)]">
                    Showing first {allowlistEntriesCount.toLocaleString("en-US")} entries.
                  </p>
                ) : null}
              </>
            )}
          </div>
        ) : null}
        <div className="rounded-xl border border-[rgba(28,28,29,0.12)] p-3">
          <p className="text-sm font-medium text-[#1c1c1d]">Frozen Accounts</p>
          {frozenAccountsError ? (
            <p className="mt-1 text-sm text-[#8a1f2a]">{frozenAccountsError}</p>
          ) : (
            <>
              <p className="mt-1 text-sm text-[rgba(28,28,29,0.66)]">
                {(frozenAccountsTotal ?? frozenAccountsCount).toLocaleString("en-US")} accounts
              </p>
              {frozenAccountsHasMore ? (
                <p className="mt-1 text-xs text-[rgba(28,28,29,0.62)]">
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
