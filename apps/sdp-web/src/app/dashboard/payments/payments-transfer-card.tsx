"use client";

import type { PaymentsDashboardWallet as WalletRecord } from "@sdp/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ProviderRiskTable } from "./provider-risk-table";
import type { TransferSectionState } from "./use-payments-workspace";

interface PaymentsTransferCardProps {
  wallets: WalletRecord[];
  walletsLoading: boolean;
  section: TransferSectionState;
}

export function PaymentsTransferCard({
  wallets,
  walletsLoading,
  section,
}: PaymentsTransferCardProps) {
  const transferDestinationTrimmed = section.destination.trim();
  const showAllowlist =
    (section.allowlist || section.allowlistLoading || section.allowlistError) &&
    !section.allowlistDismissed;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Transfer</CardTitle>
        <CardDescription>
          Compliance scores are required and shown before transfer submission.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="transfer-source">Source wallet</Label>
          <select
            id="transfer-source"
            className="h-10 rounded-lg border border-[rgba(28,28,29,0.16)] bg-white px-3 text-sm text-[#1c1c1d]"
            value={section.source}
            onChange={(event) => section.setSource(event.currentTarget.value)}
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
          <Label htmlFor="transfer-destination">Destination address</Label>
          <Input
            id="transfer-destination"
            value={section.destination}
            onChange={(event) => section.setDestination(event.currentTarget.value)}
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
            disabled={section.complianceLoading || !transferDestinationTrimmed || !section.source}
          >
            {section.complianceLoading ? "Checking..." : "Check risk score"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void section.loadAllowlist();
            }}
            disabled={section.allowlistLoading || !section.source}
          >
            {section.allowlistLoading ? "Loading allowlist..." : "Show source allowlist"}
          </Button>
        </div>

        {showAllowlist ? (
          <div className="rounded-xl border border-[rgba(28,28,29,0.12)] bg-white p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-[#1c1c1d]">Source wallet allowlist</p>
              <button
                type="button"
                onClick={section.dismissAllowlist}
                aria-label="Close source wallet allowlist"
                className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-[rgba(28,28,29,0.12)] text-xs font-semibold text-[rgba(28,28,29,0.66)] transition-colors hover:bg-[rgba(28,28,29,0.06)]"
              >
                X
              </button>
            </div>
            {section.allowlistLoading ? (
              <p className="text-sm text-[rgba(28,28,29,0.72)]">Loading allowlist...</p>
            ) : section.allowlistError ? (
              <p className="text-sm text-[#9e2b38]">{section.allowlistError}</p>
            ) : (section.allowlist ?? []).length === 0 ? (
              <p className="text-sm text-[rgba(28,28,29,0.72)]">
                No destination addresses in allowlist.
              </p>
            ) : (
              <ul className="grid gap-1">
                {(section.allowlist ?? []).slice(0, 20).map((entry) => (
                  <li key={entry} className="font-mono text-xs text-[rgba(28,28,29,0.78)]">
                    {entry}
                  </li>
                ))}
                {(section.allowlist ?? []).length > 20 ? (
                  <li className="text-xs text-[rgba(28,28,29,0.6)]">
                    +{(section.allowlist ?? []).length - 20} more addresses
                  </li>
                ) : null}
              </ul>
            )}
          </div>
        ) : null}

        {section.compliance && !section.complianceDismissed ? (
          <ProviderRiskTable
            title="Risk score results"
            snapshot={section.compliance}
            onClose={section.dismissCompliance}
          />
        ) : null}

        <div className="grid gap-2 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="transfer-token">Token</Label>
            <Input
              id="transfer-token"
              value={section.token}
              onChange={(event) => section.setToken(event.currentTarget.value)}
              placeholder="SOL or mint address"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="transfer-amount">Amount</Label>
            <Input
              id="transfer-amount"
              value={section.amount}
              onChange={(event) => section.setAmount(event.currentTarget.value)}
              placeholder="1.00"
            />
          </div>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="transfer-memo">Memo (optional)</Label>
          <Input
            id="transfer-memo"
            value={section.memo}
            onChange={(event) => section.setMemo(event.currentTarget.value)}
            placeholder="Invoice #1234"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            onClick={() => {
              void section.submit();
            }}
            disabled={section.isSubmitting || !section.canSubmit}
          >
            {section.isSubmitting ? "Sending..." : "Send transfer"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
