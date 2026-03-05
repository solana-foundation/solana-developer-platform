"use client";

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { PaymentsDestinationAllowlistCard } from "./payments-destination-allowlist-card";
import { PaymentsTransferCard } from "./payments-transfer-card";
import { usePaymentsWorkspace } from "./use-payments-workspace";

export function PaymentsWorkspace() {
  const { issuanceTab } = useDashboardWorkspace();
  const workspace = usePaymentsWorkspace();

  if (issuanceTab === "playground") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>API playground</CardTitle>
          <CardDescription>API playground for Payments coming soon.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="grid gap-6">
      <PaymentsDestinationAllowlistCard
        wallets={workspace.wallets}
        walletsLoading={workspace.walletsLoading}
        walletsError={workspace.walletsError}
        section={workspace.addAddressSection}
      />
      <PaymentsTransferCard
        wallets={workspace.wallets}
        walletsLoading={workspace.walletsLoading}
        section={workspace.transferSection}
      />
    </div>
  );
}
