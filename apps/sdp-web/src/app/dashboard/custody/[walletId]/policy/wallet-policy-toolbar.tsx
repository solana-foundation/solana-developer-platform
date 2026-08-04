"use client";

import { ListChecks } from "lucide-react";
import { DashboardNavigationLink as Link } from "@/components/dashboard-navigation-link";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { RevisionHistoryDrawer } from "./revision-history-drawer";

export function WalletPolicyToolbar({
  walletHref,
  walletId,
  initialRevisionId,
}: {
  walletHref: string;
  walletId: string;
  initialRevisionId?: string;
}) {
  const t = useTranslations();

  return (
    <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
      <Button asChild variant="outline" size="sm">
        <Link href={`${walletHref}/policy/audit`}>
          <ListChecks className="size-4" />
          {t("DashboardCustody.policyAuditTitle")}
        </Link>
      </Button>
      <RevisionHistoryDrawer walletId={walletId} initialRevisionId={initialRevisionId} />
    </div>
  );
}
