"use client";

import type { PaymentsDashboardWallet as WalletRecord } from "@sdp/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ProviderRiskTable } from "./provider-risk-table";
import type { DestinationAllowlistSectionState } from "./use-payments-workspace";

interface PaymentsDestinationAllowlistCardProps {
  wallets: WalletRecord[];
  walletsLoading: boolean;
  walletsError: string | null;
  section: DestinationAllowlistSectionState;
}

export function PaymentsDestinationAllowlistCard({
  wallets,
  walletsLoading,
  walletsError,
  section,
}: PaymentsDestinationAllowlistCardProps) {
  const addAddressTrimmed = section.address.trim();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Destination allowlist</CardTitle>
        <CardDescription>
          Add wallet addresses with compliance screening before they are added to policy.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {walletsLoading ? (
          <p className="text-sm text-[rgba(28,28,29,0.72)]">Loading wallets...</p>
        ) : null}
        {walletsError ? <p className="text-sm text-[#9e2b38]">{walletsError}</p> : null}

        <div className="grid gap-2">
          <Label htmlFor="add-wallet">Source wallet</Label>
          <select
            id="add-wallet"
            className="h-10 rounded-lg border border-[rgba(28,28,29,0.16)] bg-white px-3 text-sm text-[#1c1c1d]"
            value={section.walletId}
            onChange={(event) => section.setWalletId(event.currentTarget.value)}
            disabled={walletsLoading || wallets.length === 0}
          >
            {wallets.map((wallet) => (
              <option key={wallet.walletId} value={wallet.walletId}>
                {wallet.label ?? "Untitled"} ({wallet.walletId})
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="add-address">Address to add</Label>
          <Input
            id="add-address"
            value={section.address}
            onChange={(event) => section.setAddress(event.currentTarget.value)}
            placeholder="Destination Solana address"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void section.checkCompliance();
            }}
            disabled={section.complianceLoading || !addAddressTrimmed || !section.walletId}
          >
            {section.complianceLoading ? "Checking..." : "Check risk score"}
          </Button>
          <Button
            type="button"
            onClick={() => {
              void section.submit();
            }}
            disabled={section.isSubmitting || !section.canSubmit || section.policyLoading}
          >
            {section.isSubmitting ? "Adding..." : "Add address"}
          </Button>
        </div>

        {section.compliance && !section.complianceDismissed ? (
          <ProviderRiskTable
            title="Risk score results"
            snapshot={section.compliance}
            onClose={section.dismissCompliance}
          />
        ) : null}

        {section.error ? (
          <div className="rounded-xl border border-[rgba(158,43,56,0.2)] bg-[rgba(158,43,56,0.06)] px-3 py-2 text-sm text-[#9e2b38]">
            {section.error}
          </div>
        ) : null}

        {section.success ? (
          <div className="rounded-xl border border-[rgba(17,94,61,0.18)] bg-[rgba(16,185,129,0.1)] px-3 py-2 text-sm text-[#115e3d]">
            {section.success}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
