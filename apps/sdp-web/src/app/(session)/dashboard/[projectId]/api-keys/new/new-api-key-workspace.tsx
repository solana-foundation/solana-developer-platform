"use client";

import type { Action } from "@sdp/types/actions";
import { Button } from "@sdp/ui/button";
import { ApiKeyAuthoringWorkspace } from "@/app/(session)/dashboard/[projectId]/api-keys/api-key-authoring-workspace";
import { NewApiKeySkeleton } from "@/app/(session)/dashboard/[projectId]/api-keys/api-key-page-skeletons";
import { useWalletSummaries } from "@/app/(session)/dashboard/[projectId]/payments/shared-reads";
import { useTranslations } from "@/i18n/provider";

export function NewApiKeyWorkspace({ offeredActions }: { offeredActions: Action[] }) {
  const t = useTranslations();
  const wallets = useWalletSummaries({ includeBalances: false });
  if (wallets.data) {
    return (
      <ApiKeyAuthoringWorkspace
        mode="create"
        wallets={wallets.data}
        offeredActions={offeredActions}
      />
    );
  }
  if (wallets.error) {
    return (
      <div role="alert" className="flex flex-col items-start gap-3 px-4 py-10 md:px-6">
        <p className="text-sm text-destructive-strong">
          {t("DashboardCustody.unableToLoadWallets")}
        </p>
        <Button type="button" size="sm" onClick={() => void wallets.mutate()}>
          {t("Shared.apiKeys.retry")}
        </Button>
      </div>
    );
  }
  return <NewApiKeySkeleton />;
}
