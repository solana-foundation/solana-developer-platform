"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import {
  screenAddressCompliance,
  type ComplianceIntent,
  type ComplianceProviderResult,
} from "@/lib/compliance";
import type {
  PaymentsDashboardWallet as WalletRecord,
  PaymentsDashboardWalletsEnvelope as WalletsEnvelope,
  PaymentTransferEnvelope as TransferEnvelope,
  PaymentTransferSummary as TransferRecord,
  PaymentWalletPolicy as WalletPolicy,
  PaymentWalletPolicyEnvelope as WalletPolicyEnvelope,
} from "@sdp/types";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type ComplianceSnapshot = {
  address: string;
  checkedAt: string;
  providers: ComplianceProviderResult[];
};

function getDevnetExplorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;
}

function getApiError(body: { error?: { message?: string } }, fallback: string): string {
  if (typeof body.error?.message === "string" && body.error.message) {
    return body.error.message;
  }
  return fallback;
}

function toProviderLabel(value: string): string {
  const labels: Record<string, string> = {
    range: "Range",
    elliptic: "Elliptic",
    trm: "TRM",
    chainalysis: "Chainalysis",
  };
  return labels[value] ?? value.toUpperCase();
}

function formatRiskScore(result: ComplianceProviderResult): string {
  if (typeof result.riskScore === "number" && typeof result.riskLevel === "string" && result.riskLevel) {
    return `${result.riskScore} - ${result.riskLevel}`;
  }
  if (typeof result.riskScore === "number") {
    return String(result.riskScore);
  }
  if (
    result.provider === "trm" &&
    result.status === "ok" &&
    result.riskScore === null &&
    (!result.riskLevel || !result.riskLevel.trim())
  ) {
    return "No TRM attribution";
  }
  if (result.status === "error" && typeof result.message === "string" && result.message) {
    return result.message;
  }
  if (result.status === "unavailable") {
    return "Unavailable";
  }
  if (result.status === "ok" && typeof result.riskLevel === "string" && result.riskLevel) {
    return result.riskLevel;
  }
  if (result.status === "error") {
    return "Error";
  }
  return "N/A";
}

type RiskTone = "green" | "yellow" | "red" | "neutral";

function resolveRiskTone(result: ComplianceProviderResult): RiskTone {
  if (result.status !== "ok") {
    return "neutral";
  }

  if (typeof result.riskScore === "number") {
    if (result.riskScore >= 7) {
      return "red";
    }
    if (result.riskScore >= 3) {
      return "yellow";
    }
    return "green";
  }

  const riskLevel = result.riskLevel?.toLowerCase() ?? "";
  if (!riskLevel) {
    return "neutral";
  }

  if (
    riskLevel.includes("severe") ||
    riskLevel.includes("high") ||
    riskLevel.includes("critical") ||
    riskLevel.includes("elevated")
  ) {
    return "red";
  }

  if (
    riskLevel.includes("medium") ||
    riskLevel.includes("moderate") ||
    riskLevel.includes("watch")
  ) {
    return "yellow";
  }

  if (
    riskLevel.includes("low") ||
    riskLevel.includes("very low") ||
    riskLevel.includes("none") ||
    riskLevel.includes("minimal")
  ) {
    return "green";
  }

  return "neutral";
}

function riskToneClassName(tone: RiskTone): string {
  if (tone === "green") {
    return "border-[rgba(17,94,61,0.18)] bg-[rgba(16,185,129,0.1)] text-[#115e3d]";
  }
  if (tone === "yellow") {
    return "border-[rgba(180,83,9,0.22)] bg-[rgba(245,158,11,0.12)] text-[#8a5a00]";
  }
  if (tone === "red") {
    return "border-[rgba(158,43,56,0.2)] bg-[rgba(158,43,56,0.08)] text-[#9e2b38]";
  }
  return "border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.05)] text-[rgba(28,28,29,0.72)]";
}

function ProviderRiskTable({
  title,
  snapshot,
  onClose,
}: {
  title: string;
  snapshot: ComplianceSnapshot | null;
  onClose?: () => void;
}) {
  if (!snapshot || snapshot.providers.length === 0) {
    return null;
  }

  const providers = [...snapshot.providers].sort((left, right) =>
    toProviderLabel(left.provider).localeCompare(toProviderLabel(right.provider))
  );

  return (
    <div className="rounded-xl border border-[rgba(28,28,29,0.12)] bg-white p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-[#1c1c1d]">{title}</p>
        <div className="flex items-center gap-2">
          <p className="text-xs text-[rgba(28,28,29,0.56)]">
            {new Date(snapshot.checkedAt).toLocaleString()}
          </p>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label={`Close ${title}`}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-[rgba(28,28,29,0.12)] text-xs font-semibold text-[rgba(28,28,29,0.66)] transition-colors hover:bg-[rgba(28,28,29,0.06)]"
            >
              X
            </button>
          ) : null}
        </div>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Provider</TableHead>
            <TableHead>Risk score</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {providers.map((provider) => (
            <TableRow key={provider.provider}>
              <TableCell className="font-medium text-[#1c1c1d]">
                {toProviderLabel(provider.provider)}
              </TableCell>
              <TableCell className="text-[rgba(28,28,29,0.8)]">
                <span
                  className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${riskToneClassName(resolveRiskTone(provider))}`}
                >
                  {formatRiskScore(provider)}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

async function fetchWallets(): Promise<WalletRecord[]> {
  const response = await fetch("/api/dashboard/wallets", {
    method: "GET",
    cache: "no-store",
  });
  const body = (await response.json().catch(() => ({}))) as WalletsEnvelope;
  if (!response.ok) {
    throw new Error(getApiError(body, `Wallet list request failed (${response.status}).`));
  }
  return body.data?.wallets ?? [];
}

async function fetchWalletPolicy(walletId: string): Promise<WalletPolicy> {
  const response = await fetch(
    `/api/dashboard/payments/wallets/${encodeURIComponent(walletId)}/policies`,
    {
      method: "GET",
      cache: "no-store",
    }
  );
  const body = (await response.json().catch(() => ({}))) as WalletPolicyEnvelope;
  if (!response.ok) {
    throw new Error(getApiError(body, `Wallet policy request failed (${response.status}).`));
  }

  return (
    body.data?.policy ?? {
      walletId,
      destinationAllowlist: [],
    }
  );
}

async function updateWalletPolicy(walletId: string, policy: WalletPolicy): Promise<WalletPolicy> {
  const response = await fetch(
    `/api/dashboard/payments/wallets/${encodeURIComponent(walletId)}/policies`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        destinationAllowlist: policy.destinationAllowlist,
        ...(policy.maxTransferAmount ? { maxTransferAmount: policy.maxTransferAmount } : {}),
        ...(policy.maxDailyAmount ? { maxDailyAmount: policy.maxDailyAmount } : {}),
      }),
    }
  );
  const body = (await response.json().catch(() => ({}))) as WalletPolicyEnvelope;
  if (!response.ok) {
    throw new Error(getApiError(body, `Wallet policy update failed (${response.status}).`));
  }

  if (!body.data?.policy) {
    throw new Error("Wallet policy update returned an empty response.");
  }

  return body.data.policy;
}

async function createTransfer(input: {
  source: string;
  destination: string;
  token: string;
  amount: string;
  memo?: string;
}): Promise<TransferRecord> {
  const response = await fetch("/api/dashboard/payments/transfers", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source: input.source,
      destination: input.destination,
      token: input.token,
      amount: input.amount,
      ...(input.memo ? { memo: input.memo } : {}),
    }),
  });
  const body = (await response.json().catch(() => ({}))) as TransferEnvelope;
  if (!response.ok) {
    throw new Error(getApiError(body, `Transfer request failed (${response.status}).`));
  }

  if (!body.data?.transfer) {
    throw new Error("Transfer response is missing transfer details.");
  }

  return body.data.transfer;
}

async function runComplianceCheck(
  address: string,
  intent: ComplianceIntent
): Promise<ComplianceSnapshot> {
  const result = await screenAddressCompliance({
    address,
    network: "solana",
    intent,
  });

  return {
    address,
    checkedAt: result.checkedAt,
    providers: result.providers,
  };
}

export function PaymentsWorkspace() {
  const { issuanceTab } = useDashboardWorkspace();
  const [wallets, setWallets] = useState<WalletRecord[]>([]);
  const [walletsLoading, setWalletsLoading] = useState(true);
  const [walletsError, setWalletsError] = useState<string | null>(null);

  const [addWalletId, setAddWalletId] = useState("");
  const [addAddress, setAddAddress] = useState("");
  const [addPolicy, setAddPolicy] = useState<WalletPolicy | null>(null);
  const [addPolicyLoading, setAddPolicyLoading] = useState(false);
  const [addCompliance, setAddCompliance] = useState<ComplianceSnapshot | null>(null);
  const [addComplianceLoading, setAddComplianceLoading] = useState(false);
  const [addComplianceDismissed, setAddComplianceDismissed] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addSuccess, setAddSuccess] = useState<string | null>(null);
  const [isAddingAddress, setIsAddingAddress] = useState(false);

  const [transferSource, setTransferSource] = useState("");
  const [transferDestination, setTransferDestination] = useState("");
  const [transferToken, setTransferToken] = useState("SOL");
  const [transferAmount, setTransferAmount] = useState("");
  const [transferMemo, setTransferMemo] = useState("");
  const [transferCompliance, setTransferCompliance] = useState<ComplianceSnapshot | null>(null);
  const [transferComplianceLoading, setTransferComplianceLoading] = useState(false);
  const [transferComplianceDismissed, setTransferComplianceDismissed] = useState(false);
  const [transferPolicyAllowlist, setTransferPolicyAllowlist] = useState<string[]>([]);
  const [transferAllowlist, setTransferAllowlist] = useState<string[] | null>(null);
  const [transferAllowlistLoading, setTransferAllowlistLoading] = useState(false);
  const [transferAllowlistError, setTransferAllowlistError] = useState<string | null>(null);
  const [transferAllowlistDismissed, setTransferAllowlistDismissed] = useState(false);
  const [isSubmittingTransfer, setIsSubmittingTransfer] = useState(false);

  useEffect(() => {
    const loadWallets = async () => {
      setWalletsLoading(true);
      setWalletsError(null);
      try {
        const nextWallets = await fetchWallets();
        setWallets(nextWallets);
      } catch (error) {
        setWalletsError(error instanceof Error ? error.message : "Failed to load wallets.");
      } finally {
        setWalletsLoading(false);
      }
    };

    void loadWallets();
  }, []);

  useEffect(() => {
    if (wallets.length === 0) {
      setAddWalletId("");
      setTransferSource("");
      return;
    }

    if (!addWalletId) {
      setAddWalletId(wallets[0]?.walletId ?? "");
    }
    if (!transferSource) {
      setTransferSource(wallets[0]?.walletId ?? "");
    }
  }, [wallets, addWalletId, transferSource]);

  useEffect(() => {
    if (!addWalletId) {
      setAddPolicy(null);
      return;
    }

    const loadPolicy = async () => {
      setAddPolicyLoading(true);
      setAddError(null);
      try {
        const nextPolicy = await fetchWalletPolicy(addWalletId);
        setAddPolicy(nextPolicy);
      } catch (error) {
        setAddError(error instanceof Error ? error.message : "Failed to load wallet policy.");
        setAddPolicy(null);
      } finally {
        setAddPolicyLoading(false);
      }
    };

    void loadPolicy();
  }, [addWalletId]);

  useEffect(() => {
    if (!transferSource) {
      setTransferPolicyAllowlist([]);
      return;
    }

    const loadTransferPolicy = async () => {
      try {
        const policy = await fetchWalletPolicy(transferSource);
        setTransferPolicyAllowlist(policy.destinationAllowlist);
      } catch {
        setTransferPolicyAllowlist([]);
      }
    };

    void loadTransferPolicy();
  }, [transferSource]);

  const addAddressTrimmed = addAddress.trim();
  const transferDestinationTrimmed = transferDestination.trim();
  const transferHasComplianceForDestination =
    !!transferCompliance &&
    transferCompliance.address === transferDestinationTrimmed &&
    transferCompliance.providers.length > 0;
  const transferDestinationIsAllowlisted =
    !!transferDestinationTrimmed && transferPolicyAllowlist.includes(transferDestinationTrimmed);
  const canAddAddress =
    !!addWalletId &&
    !!addAddressTrimmed &&
    !!addCompliance &&
    addCompliance.address === addAddressTrimmed &&
    addCompliance.providers.length > 0;
  const canSubmitTransfer =
    !!transferSource &&
    !!transferDestinationTrimmed &&
    !!transferAmount.trim() &&
    (transferHasComplianceForDestination || transferDestinationIsAllowlisted);

  const allowlistAddresses = useMemo(() => addPolicy?.destinationAllowlist ?? [], [addPolicy]);

  const checkAddAddressCompliance = async () => {
    if (!addAddressTrimmed) {
      setAddError("Address is required.");
      return;
    }

    setAddComplianceLoading(true);
    setAddComplianceDismissed(false);
    setAddError(null);
    setAddSuccess(null);
    try {
      const snapshot = await runComplianceCheck(addAddressTrimmed, "wallet_address_addition");
      setAddCompliance(snapshot);
    } catch (error) {
      setAddCompliance(null);
      setAddError(error instanceof Error ? error.message : "Compliance check failed.");
    } finally {
      setAddComplianceLoading(false);
    }
  };

  const addDestinationAddress = async () => {
    if (!canAddAddress || !addPolicy) {
      setAddError("Run compliance check before adding the address.");
      return;
    }

    if (allowlistAddresses.includes(addAddressTrimmed)) {
      setAddSuccess("Address is already in the destination allowlist.");
      return;
    }

    setIsAddingAddress(true);
    setAddError(null);
    setAddSuccess(null);
    try {
      const updated = await updateWalletPolicy(addWalletId, {
        ...addPolicy,
        destinationAllowlist: [...allowlistAddresses, addAddressTrimmed],
      });
      setAddPolicy(updated);
      if (addWalletId === transferSource) {
        setTransferPolicyAllowlist(updated.destinationAllowlist);
      }
      setAddSuccess("Address added to wallet destination allowlist.");
    } catch (error) {
      setAddError(error instanceof Error ? error.message : "Failed to add destination address.");
    } finally {
      setIsAddingAddress(false);
    }
  };

  const checkTransferCompliance = async () => {
    if (!transferDestinationTrimmed) {
      toast.error("Compliance check failed.", {
        description: "Destination address is required.",
        position: "bottom-right",
      });
      return;
    }

    setTransferComplianceLoading(true);
    setTransferComplianceDismissed(false);
    try {
      const snapshot = await runComplianceCheck(transferDestinationTrimmed, "transfer_destination");
      setTransferCompliance(snapshot);
    } catch (error) {
      setTransferCompliance(null);
      toast.error("Compliance check failed.", {
        description: error instanceof Error ? error.message : "Compliance check failed.",
        position: "bottom-right",
      });
    } finally {
      setTransferComplianceLoading(false);
    }
  };

  const submitTransfer = async () => {
    if (!canSubmitTransfer) {
      toast.error("Transfer blocked.", {
        description:
          "Run compliance check or use a destination already in the source wallet allowlist.",
        position: "bottom-right",
      });
      return;
    }

    setIsSubmittingTransfer(true);
    try {
      const transfer = await createTransfer({
        source: transferSource,
        destination: transferDestinationTrimmed,
        token: transferToken.trim() || "SOL",
        amount: transferAmount.trim(),
        memo: transferMemo.trim() || undefined,
      });

      if (transfer.signature) {
        const explorerUrl = getDevnetExplorerUrl(transfer.signature);
        toast.success("Transfer submitted.", {
          description: (
            <span>
              Transaction sent.{" "}
              <a
                href={explorerUrl}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                View on Solana Explorer
              </a>
            </span>
          ),
          position: "bottom-right",
        });
      } else {
        toast.success("Transfer submitted.", {
          description: `Status: ${transfer.status}`,
          position: "bottom-right",
        });
      }
    } catch (error) {
      toast.error("Transfer failed.", {
        description: error instanceof Error ? error.message : "Transfer failed.",
        position: "bottom-right",
      });
    } finally {
      setIsSubmittingTransfer(false);
    }
  };

  const loadTransferAllowlist = async () => {
    if (!transferSource) {
      setTransferAllowlistError("Select a source wallet first.");
      return;
    }

    setTransferAllowlistLoading(true);
    setTransferAllowlistDismissed(false);
    setTransferAllowlistError(null);
    try {
      const policy = await fetchWalletPolicy(transferSource);
      setTransferPolicyAllowlist(policy.destinationAllowlist);
      setTransferAllowlist(policy.destinationAllowlist);
    } catch (error) {
      setTransferAllowlist(null);
      setTransferAllowlistError(
        error instanceof Error ? error.message : "Failed to load destination allowlist."
      );
    } finally {
      setTransferAllowlistLoading(false);
    }
  };

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
      <Card>
        <CardHeader>
          <CardTitle>Destination allowlist</CardTitle>
          <CardDescription>
            Add wallet addresses with compliance screening before they are added to policy.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {walletsLoading ? <p className="text-sm text-[rgba(28,28,29,0.72)]">Loading wallets...</p> : null}
          {walletsError ? (
            <p className="text-sm text-[#9e2b38]">{walletsError}</p>
          ) : null}

          <div className="grid gap-2">
            <Label htmlFor="add-wallet">Source wallet</Label>
            <select
              id="add-wallet"
              className="h-10 rounded-lg border border-[rgba(28,28,29,0.16)] bg-white px-3 text-sm text-[#1c1c1d]"
              value={addWalletId}
              onChange={(event) => {
                setAddWalletId(event.currentTarget.value);
                setAddCompliance(null);
                setAddComplianceDismissed(false);
                setAddSuccess(null);
              }}
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
              value={addAddress}
              onChange={(event) => {
                setAddAddress(event.currentTarget.value);
                setAddCompliance(null);
                setAddComplianceDismissed(false);
              }}
              placeholder="Destination Solana address"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                void checkAddAddressCompliance();
              }}
              disabled={addComplianceLoading || !addAddressTrimmed || !addWalletId}
            >
              {addComplianceLoading ? "Checking..." : "Check risk score"}
            </Button>
            <Button
              type="button"
              onClick={() => {
                void addDestinationAddress();
              }}
              disabled={isAddingAddress || !canAddAddress || addPolicyLoading}
            >
              {isAddingAddress ? "Adding..." : "Add address"}
            </Button>
          </div>

          {addCompliance && !addComplianceDismissed ? (
            <ProviderRiskTable
              title="Risk score results"
              snapshot={addCompliance}
              onClose={() => setAddComplianceDismissed(true)}
            />
          ) : null}

          {addError ? (
            <div className="rounded-xl border border-[rgba(158,43,56,0.2)] bg-[rgba(158,43,56,0.06)] px-3 py-2 text-sm text-[#9e2b38]">
              {addError}
            </div>
          ) : null}

          {addSuccess ? (
            <div className="rounded-xl border border-[rgba(17,94,61,0.18)] bg-[rgba(16,185,129,0.1)] px-3 py-2 text-sm text-[#115e3d]">
              {addSuccess}
            </div>
          ) : null}

        </CardContent>
      </Card>

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
              value={transferSource}
              onChange={(event) => {
                setTransferSource(event.currentTarget.value);
                setTransferAllowlist(null);
                setTransferAllowlistError(null);
                setTransferAllowlistDismissed(false);
              }}
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
              value={transferDestination}
              onChange={(event) => {
                setTransferDestination(event.currentTarget.value);
                setTransferCompliance(null);
                setTransferComplianceDismissed(false);
              }}
              placeholder="Destination Solana address"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                void checkTransferCompliance();
              }}
              disabled={transferComplianceLoading || !transferDestinationTrimmed || !transferSource}
            >
              {transferComplianceLoading ? "Checking..." : "Check risk score"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                void loadTransferAllowlist();
              }}
              disabled={transferAllowlistLoading || !transferSource}
            >
              {transferAllowlistLoading ? "Loading allowlist..." : "Show source allowlist"}
            </Button>
          </div>

          {(transferAllowlist || transferAllowlistLoading || transferAllowlistError) &&
          !transferAllowlistDismissed ? (
            <div className="rounded-xl border border-[rgba(28,28,29,0.12)] bg-white p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-[#1c1c1d]">Source wallet allowlist</p>
                <button
                  type="button"
                  onClick={() => setTransferAllowlistDismissed(true)}
                  aria-label="Close source wallet allowlist"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-[rgba(28,28,29,0.12)] text-xs font-semibold text-[rgba(28,28,29,0.66)] transition-colors hover:bg-[rgba(28,28,29,0.06)]"
                >
                  X
                </button>
              </div>
              {transferAllowlistLoading ? (
                <p className="text-sm text-[rgba(28,28,29,0.72)]">Loading allowlist...</p>
              ) : transferAllowlistError ? (
                <p className="text-sm text-[#9e2b38]">{transferAllowlistError}</p>
              ) : (transferAllowlist ?? []).length === 0 ? (
                <p className="text-sm text-[rgba(28,28,29,0.72)]">
                  No destination addresses in allowlist.
                </p>
              ) : (
                <ul className="grid gap-1">
                  {(transferAllowlist ?? []).slice(0, 20).map((entry) => (
                    <li key={entry} className="font-mono text-xs text-[rgba(28,28,29,0.78)]">
                      {entry}
                    </li>
                  ))}
                  {(transferAllowlist ?? []).length > 20 ? (
                    <li className="text-xs text-[rgba(28,28,29,0.6)]">
                      +{(transferAllowlist ?? []).length - 20} more addresses
                    </li>
                  ) : null}
                </ul>
              )}
            </div>
          ) : null}

          {transferCompliance && !transferComplianceDismissed ? (
            <ProviderRiskTable
              title="Risk score results"
              snapshot={transferCompliance}
              onClose={() => setTransferComplianceDismissed(true)}
            />
          ) : null}

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="transfer-token">Token</Label>
              <Input
                id="transfer-token"
                value={transferToken}
                onChange={(event) => setTransferToken(event.currentTarget.value)}
                placeholder="SOL or mint address"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="transfer-amount">Amount</Label>
              <Input
                id="transfer-amount"
                value={transferAmount}
                onChange={(event) => setTransferAmount(event.currentTarget.value)}
                placeholder="1.00"
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="transfer-memo">Memo (optional)</Label>
            <Input
              id="transfer-memo"
              value={transferMemo}
              onChange={(event) => setTransferMemo(event.currentTarget.value)}
              placeholder="Invoice #1234"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              onClick={() => {
                void submitTransfer();
              }}
              disabled={isSubmittingTransfer || !canSubmitTransfer}
            >
              {isSubmittingTransfer ? "Sending..." : "Send transfer"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
