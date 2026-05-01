"use client";

import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useDashboardWarmSnapshot } from "@/lib/use-dashboard-warm-snapshot";
import { ApiKeyFlashSurface } from "./api-key-flash-surface";
import { ApiKeysTableClient } from "./api-keys-table-client";
import { CreateApiKeyModal } from "./create-api-key-modal";

export function ApiKeysWarmPage() {
  const { dashboardAccess } = useDashboardWorkspace();
  const { data: snapshot } = useDashboardWarmSnapshot({ revalidate: false });
  const apiKeys = snapshot?.apiKeys.data ?? [];
  const wallets = snapshot?.wallets.data ?? [];

  return (
    <div className="w-full flex flex-col gap-6">
      <ApiKeyFlashSurface />

      <Card>
        <CardHeader>
          <CardTitle>Existing API keys</CardTitle>
          <CardDescription>Active and historical keys for this workspace.</CardDescription>
          {dashboardAccess.capabilities.canManageApiKeys ? (
            <CardAction>
              <CreateApiKeyModal triggerLabel="New API key" wallets={wallets} />
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent>
          {!dashboardAccess.capabilities.canManageApiKeys ? (
            <div className="mb-4 rounded-[10px] border border-[rgba(28,28,29,0.14)] bg-[rgba(28,28,29,0.03)] px-3 py-2 text-xs text-[rgba(28,28,29,0.72)]">
              You can view API keys, but only admins can create, rotate, or delete them.
            </div>
          ) : null}
          <div className="mb-4 rounded-[10px] border border-[rgba(28,28,29,0.14)] bg-[rgba(28,28,29,0.03)] px-3 py-2 text-xs text-[rgba(28,28,29,0.72)]">
            <p className="text-xs text-[rgba(28,28,29,0.72)]">
              Rotation hint: rotate active keys only. The dashboard uses a 24-hour grace period; use
              the API for custom grace values (0-168h). New key secrets are shown once.
            </p>
          </div>
          {snapshot?.apiKeys.error ? (
            <div className="mb-4 rounded-[10px] border border-[#c71f37]/15 bg-[#c71f37]/[0.04] px-3 py-2 text-xs text-[#8a1f2a]">
              {snapshot.apiKeys.error}
            </div>
          ) : null}
          <ApiKeysTableClient
            initialApiKeys={apiKeys}
            canManageApiKeys={dashboardAccess.capabilities.canManageApiKeys}
          />
        </CardContent>
      </Card>
    </div>
  );
}
