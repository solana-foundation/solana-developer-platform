"use client";

import { getActiveWarmSnapshotApiKeys } from "@/lib/dashboard-warm-snapshot";
import { useDashboardWarmSnapshot } from "@/lib/use-dashboard-warm-snapshot";
import { IssuanceWorkspace } from "./issuance-workspace";

interface IssuanceWarmPageProps {
  apiBaseUrl: string | null;
}

export function IssuanceWarmPage({ apiBaseUrl }: IssuanceWarmPageProps) {
  const { data: snapshot } = useDashboardWarmSnapshot();
  const tokens = snapshot?.issuedTokens.data ?? [];
  const apiKeys = getActiveWarmSnapshotApiKeys(snapshot?.apiKeys.data ?? []);
  const signerWallets = snapshot?.wallets.data ?? [];

  return (
    <IssuanceWorkspace
      tokens={tokens}
      templates={[]}
      apiKeys={apiKeys}
      signerWallets={signerWallets}
      apiBaseUrl={apiBaseUrl}
      templatesError={null}
      tokensNotice={snapshot?.issuedTokens.error ?? null}
      signerWalletsError={snapshot?.wallets.error ?? null}
    />
  );
}
