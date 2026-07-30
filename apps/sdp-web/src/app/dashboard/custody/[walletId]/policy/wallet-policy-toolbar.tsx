"use client";

import { History, ListChecks } from "lucide-react";
import { DashboardNavigationLink as Link } from "@/components/dashboard-navigation-link";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";

export function WalletPolicyToolbar({ walletHref }: { walletHref: string }) {
  const t = useTranslations();

  return (
    <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
      <Button asChild variant="outline" size="sm">
        <Link href={`${walletHref}/policy/audit`}>
          <ListChecks className="size-4" />
          {t("DashboardCustody.policyAuditTitle")}
        </Link>
      </Button>
      <Button asChild variant="outline" size="sm">
        <Link href={`${walletHref}/policy/revisions`}>
          <History className="size-4" />
          {t("DashboardCustody.policyAuditRevisionHistory")}
        </Link>
      </Button>
    </div>
  );
}
