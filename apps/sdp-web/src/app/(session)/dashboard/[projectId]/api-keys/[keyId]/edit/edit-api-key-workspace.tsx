"use client";

import type { Action } from "@sdp/types/actions";
import { Button } from "@sdp/ui/button";
import Link from "next/link";
import { ApiKeyAuthoringWorkspace } from "@/app/(session)/dashboard/[projectId]/api-keys/api-key-authoring-workspace";
import { EditApiKeySkeleton } from "@/app/(session)/dashboard/[projectId]/api-keys/api-key-page-skeletons";
import { useApiKeyForAuthoring } from "@/app/(session)/dashboard/[projectId]/api-keys/api-keys.data";
import { useWalletSummaries } from "@/app/(session)/dashboard/[projectId]/payments/shared-reads";
import { useTranslations } from "@/i18n/provider";
import { useProjectHref } from "@/lib/use-dashboard-project";

export function EditApiKeyWorkspace({
  keyId,
  offeredActions,
}: {
  keyId: string;
  offeredActions: Action[];
}) {
  const t = useTranslations();
  const href = useProjectHref();
  const apiKey = useApiKeyForAuthoring(keyId);
  const wallets = useWalletSummaries({ includeBalances: false });

  // The form seeds its draft from the key once, so it mounts only when both reads are in.
  if (apiKey.data && wallets.data) {
    return (
      <ApiKeyAuthoringWorkspace
        mode="edit"
        wallets={wallets.data}
        offeredActions={offeredActions}
        initialKey={apiKey.data}
      />
    );
  }
  if (apiKey.error?.status === 404) {
    return (
      <div className="flex flex-col items-start gap-3 px-4 py-10 md:px-6">
        <p className="text-sm text-secondary">{t("Shared.apiKeys.keyNotFound")}</p>
        <Button asChild size="sm" variant="outline">
          <Link href={href("/dashboard/api-keys")}>{t("Shared.apiKeys.backToApiKeys")}</Link>
        </Button>
      </div>
    );
  }
  if (apiKey.error || wallets.error) {
    return (
      <div role="alert" className="flex flex-col items-start gap-3 px-4 py-10 md:px-6">
        <p className="text-sm text-destructive-strong">
          {apiKey.error
            ? t("Shared.apiKeys.loadFailed")
            : t("DashboardCustody.unableToLoadWallets")}
        </p>
        <Button
          type="button"
          size="sm"
          onClick={() => {
            if (apiKey.error) void apiKey.mutate();
            if (wallets.error) void wallets.mutate();
          }}
        >
          {t("Shared.apiKeys.retry")}
        </Button>
      </div>
    );
  }
  return <EditApiKeySkeleton />;
}
