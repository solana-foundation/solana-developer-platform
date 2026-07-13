"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useLocale, useTranslations } from "@/i18n/provider";

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
  const t = useTranslations();
  const locale = useLocale();
  const controlListSummaryTitle = controlListLabel
    ? t("DashboardIssuance.controlLists.entriesTitle", { label: controlListLabel })
    : t("DashboardIssuance.controlLists.controlList");
  const controlListDescription =
    showControlList && controlListLabel
      ? t("DashboardIssuance.controlLists.descriptionWithList", { label: controlListLabel })
      : t("DashboardIssuance.controlLists.descriptionWithoutList");

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>{t("DashboardIssuance.controlLists.title")}</CardTitle>
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
                  {t("DashboardIssuance.controlLists.entriesCount", {
                    count: (allowlistTotal ?? allowlistEntriesCount).toLocaleString(locale),
                  })}
                </p>
                {allowlistHasMore ? (
                  <p className="mt-1 text-xs text-secondary">
                    {t("DashboardIssuance.controlLists.showingEntries", {
                      count: allowlistEntriesCount.toLocaleString(locale),
                    })}
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
          <p className="text-sm font-medium text-primary">
            {t("DashboardIssuance.controlLists.frozenAccounts")}
          </p>
          {frozenAccountsError ? (
            <p className="mt-1 text-sm text-destructive-strongest">{frozenAccountsError}</p>
          ) : (
            <>
              <p className="mt-1 text-sm text-secondary">
                {t("DashboardIssuance.controlLists.accountsCount", {
                  count: (frozenAccountsTotal ?? frozenAccountsCount).toLocaleString(locale),
                })}
              </p>
              {frozenAccountsHasMore ? (
                <p className="mt-1 text-xs text-secondary">
                  {t("DashboardIssuance.controlLists.showingAccounts", {
                    count: frozenAccountsCount.toLocaleString(locale),
                  })}
                </p>
              ) : null}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
