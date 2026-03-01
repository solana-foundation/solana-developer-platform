"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEffect, useMemo, useState } from "react";

type WalletRecord = {
  id: string;
  walletId: string;
  publicKey: string;
  label: string | null;
};

type WalletsEnvelope = {
  data?: {
    wallets?: WalletRecord[];
  };
  error?: {
    message?: string;
  };
};

type WalletPolicy = {
  walletId: string;
  destinationAllowlist: string[];
  maxTransferAmount?: string;
  maxDailyAmount?: string;
};

type WalletPolicyEnvelope = {
  data?: {
    policy?: WalletPolicy;
  };
  error?: {
    message?: string;
  };
};

type TransferRecord = {
  id: string;
  status: string;
  signature: string | null;
};

type TransferEnvelope = {
  data?: {
    transfer?: TransferRecord;
  };
  error?: {
    message?: string;
  };
};

function getApiError(body: { error?: { message?: string } }, fallback: string): string {
  if (typeof body.error?.message === "string" && body.error.message) {
    return body.error.message;
  }
  return fallback;
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

export function PaymentsWorkspace() {
  const [wallets, setWallets] = useState<WalletRecord[]>([]);
  const [walletsLoading, setWalletsLoading] = useState(true);
  const [walletsError, setWalletsError] = useState<string | null>(null);

  const [addWalletId, setAddWalletId] = useState("");
  const [addAddress, setAddAddress] = useState("");
  const [addPolicy, setAddPolicy] = useState<WalletPolicy | null>(null);
  const [addPolicyLoading, setAddPolicyLoading] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addSuccess, setAddSuccess] = useState<string | null>(null);
  const [isAddingAddress, setIsAddingAddress] = useState(false);

  const [transferSource, setTransferSource] = useState("");
  const [transferDestination, setTransferDestination] = useState("");
  const [transferToken, setTransferToken] = useState("SOL");
  const [transferAmount, setTransferAmount] = useState("");
  const [transferMemo, setTransferMemo] = useState("");
  const [transferError, setTransferError] = useState<string | null>(null);
  const [transferResult, setTransferResult] = useState<TransferRecord | null>(null);
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

  const addAddressTrimmed = addAddress.trim();
  const transferDestinationTrimmed = transferDestination.trim();
  const canAddAddress = !!addWalletId && !!addAddressTrimmed;
  const canSubmitTransfer =
    !!transferSource && !!transferDestinationTrimmed && !!transferAmount.trim();

  const allowlistAddresses = useMemo(() => addPolicy?.destinationAllowlist ?? [], [addPolicy]);

  const addDestinationAddress = async () => {
    if (!canAddAddress || !addPolicy) {
      setAddError("Address is required.");
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
      setAddSuccess("Address added to wallet destination allowlist.");
      setAddAddress("");
    } catch (error) {
      setAddError(error instanceof Error ? error.message : "Failed to add destination address.");
    } finally {
      setIsAddingAddress(false);
    }
  };

  const submitTransfer = async () => {
    if (!canSubmitTransfer) {
      setTransferError("Source, destination, token, and amount are required.");
      return;
    }

    setIsSubmittingTransfer(true);
    setTransferError(null);
    setTransferResult(null);
    try {
      const transfer = await createTransfer({
        source: transferSource,
        destination: transferDestinationTrimmed,
        token: transferToken.trim() || "SOL",
        amount: transferAmount.trim(),
        memo: transferMemo.trim() || undefined,
      });
      setTransferResult(transfer);
    } catch (error) {
      setTransferError(error instanceof Error ? error.message : "Transfer failed.");
    } finally {
      setIsSubmittingTransfer(false);
    }
  };

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Destination allowlist</CardTitle>
          <CardDescription>
            Add wallet addresses to the source wallet policy destination allowlist.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {walletsLoading ? <p className="text-sm text-[rgba(28,28,29,0.72)]">Loading wallets...</p> : null}
          {walletsError ? <p className="text-sm text-[#9e2b38]">{walletsError}</p> : null}

          <div className="grid gap-2">
            <Label htmlFor="add-wallet">Source wallet</Label>
            <select
              id="add-wallet"
              className="h-10 rounded-lg border border-[rgba(28,28,29,0.16)] bg-white px-3 text-sm text-[#1c1c1d]"
              value={addWalletId}
              onChange={(event) => {
                setAddWalletId(event.currentTarget.value);
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
              onChange={(event) => setAddAddress(event.currentTarget.value)}
              placeholder="Destination Solana address"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
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

          <div className="rounded-xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.03)] p-3">
            <p className="text-sm font-medium text-[#1c1c1d]">Current allowlist</p>
            {addPolicyLoading ? (
              <p className="mt-2 text-sm text-[rgba(28,28,29,0.72)]">Loading policy...</p>
            ) : allowlistAddresses.length === 0 ? (
              <p className="mt-2 text-sm text-[rgba(28,28,29,0.72)]">No destination addresses added.</p>
            ) : (
              <ul className="mt-2 grid gap-1">
                {allowlistAddresses.slice(0, 20).map((entry) => (
                  <li key={entry} className="font-mono text-xs text-[rgba(28,28,29,0.78)]">
                    {entry}
                  </li>
                ))}
                {allowlistAddresses.length > 20 ? (
                  <li className="text-xs text-[rgba(28,28,29,0.6)]">
                    +{allowlistAddresses.length - 20} more addresses
                  </li>
                ) : null}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Transfer</CardTitle>
          <CardDescription>Submit token transfers from a source wallet to a destination address.</CardDescription>
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
              }}
              placeholder="Destination Solana address"
            />
          </div>

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

          {transferError ? (
            <div className="rounded-xl border border-[rgba(158,43,56,0.2)] bg-[rgba(158,43,56,0.06)] px-3 py-2 text-sm text-[#9e2b38]">
              {transferError}
            </div>
          ) : null}

          {transferResult ? (
            <div className="rounded-xl border border-[rgba(17,94,61,0.18)] bg-[rgba(16,185,129,0.1)] px-3 py-2 text-sm text-[#115e3d]">
              Transfer submitted: <span className="font-mono">{transferResult.id}</span> ({transferResult.status})
              {transferResult.signature ? (
                <span className="block font-mono text-xs">{transferResult.signature}</span>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
