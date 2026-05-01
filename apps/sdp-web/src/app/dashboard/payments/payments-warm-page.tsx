"use client";

import { useMemo } from "react";
import { getActiveWarmSnapshotApiKeys } from "@/lib/dashboard-warm-snapshot";
import { useDashboardWarmSnapshot } from "@/lib/use-dashboard-warm-snapshot";
import { PaymentsWorkspace } from "./payments-workspace";

interface PaymentsWarmPageProps {
  apiBaseUrl: string | null;
}

export function PaymentsWarmPage({ apiBaseUrl }: PaymentsWarmPageProps) {
  const { data: snapshot } = useDashboardWarmSnapshot();
  const apiKeys = getActiveWarmSnapshotApiKeys(snapshot?.apiKeys.data ?? []);
  const wallets = snapshot?.wallets.data ?? [];
  const issuedTokenSymbolsByMint = useMemo(
    () =>
      Object.fromEntries(
        (snapshot?.issuedTokens.data ?? [])
          .filter((token) => token.mintAddress)
          .map((token) => [token.mintAddress as string, token.symbol])
      ),
    [snapshot?.issuedTokens.data]
  );
  const aggregateError =
    snapshot?.aggregateBalance.status === "refreshing"
      ? null
      : (snapshot?.aggregateBalance.error ?? null);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <PaymentsWorkspace
        apiBaseUrl={apiBaseUrl}
        apiKeys={apiKeys}
        wallets={wallets}
        walletsError={snapshot?.wallets.error ?? null}
        aggregate={snapshot?.aggregateBalance.data ?? null}
        aggregateError={aggregateError}
        issuedTokenSymbolsByMint={issuedTokenSymbolsByMint}
        transfers={[]}
        transfersError={null}
      />
    </div>
  );
}
