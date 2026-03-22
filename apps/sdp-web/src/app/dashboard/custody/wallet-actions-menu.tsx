"use client";

import {
  checkWalletSignerMemoAction,
  requestWalletFaucetAction,
} from "@/app/dashboard/custody/actions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useEscapeKey } from "@/lib/use-escape-key";
import { cn } from "@/lib/utils";
import { ChevronDown, Droplets, Ellipsis, ShieldCheck } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

interface WalletActionsMenuProps {
  walletAddress: string;
  walletId: string;
  walletLabel: string | null;
  triggerLabel?: string;
  triggerMode?: "button" | "icon";
  triggerClassName?: string;
}

function getDevnetExplorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;
}

function formatWalletLabel(walletLabel: string | null, walletAddress: string): string {
  const trimmed = walletLabel?.trim();
  if (trimmed) return trimmed;
  return `${walletAddress.slice(0, 6)}...${walletAddress.slice(-6)}`;
}

export function WalletActionsMenu({
  walletAddress,
  walletId,
  walletLabel,
  triggerLabel = "Actions",
  triggerMode = "icon",
  triggerClassName,
}: WalletActionsMenuProps) {
  const { dashboardAccess } = useDashboardWorkspace();
  const [isFaucetOpen, setIsFaucetOpen] = useState(false);
  const [isBusy, startTransition] = useTransition();
  const resolvedWalletLabel = formatWalletLabel(walletLabel, walletAddress);

  const runSignerCheck = () => {
    startTransition(() => {
      void (async () => {
        const result = await checkWalletSignerMemoAction(walletId);

        if (result.status === "success") {
          const explorerUrl = getDevnetExplorerUrl(result.signature);

          toast.success("Signer check sent.", {
            description: (
              <span>
                Memo transaction submitted.{" "}
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
          return;
        }

        toast.error("Signer check failed.", {
          description: result.message,
          position: "bottom-right",
        });
      })();
    });
  };

  const runFaucetRequest = (amount: string) => {
    startTransition(() => {
      void (async () => {
        const loadingToastId = toast.loading("Requesting faucet airdrop...", {
          position: "bottom-right",
        });
        const result = await requestWalletFaucetAction(walletAddress, amount);

        if (result.status === "success") {
          const explorerUrl = getDevnetExplorerUrl(result.signature);

          toast.success("Faucet sent.", {
            id: loadingToastId,
            description: (
              <span>
                {result.amountSol} SOL requested.{" "}
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
          setIsFaucetOpen(false);
          return;
        }

        toast.error("Faucet failed.", {
          id: loadingToastId,
          description: result.message,
          position: "bottom-right",
        });
      })();
    });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {triggerMode === "button" ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className={cn("min-w-[132px] justify-between", triggerClassName)}
              aria-label={`Wallet actions for ${resolvedWalletLabel}`}
              disabled={isBusy}
            >
              <span>{triggerLabel}</span>
              <ChevronDown className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              className={triggerClassName}
              aria-label={`Wallet actions for ${resolvedWalletLabel}`}
              disabled={isBusy}
            >
              <Ellipsis className="h-4 w-4" />
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onSelect={() => setIsFaucetOpen(true)} disabled={isBusy}>
            <Droplets className="h-4 w-4" />
            Faucet
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={runSignerCheck}
            disabled={isBusy || !dashboardAccess.capabilities.canUseWalletSignerCheck}
          >
            <ShieldCheck className="h-4 w-4" />
            {isBusy
              ? "Proving..."
              : dashboardAccess.capabilities.canUseWalletSignerCheck
                ? "Prove ownership"
                : "Prove ownership (admin only)"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <WalletFaucetModal
        isBusy={isBusy}
        isOpen={isFaucetOpen}
        onClose={() => setIsFaucetOpen(false)}
        resolvedWalletLabel={resolvedWalletLabel}
        walletAddress={walletAddress}
        onSubmit={runFaucetRequest}
      />
    </>
  );
}

function WalletFaucetModal({
  isBusy,
  isOpen,
  onClose,
  resolvedWalletLabel,
  walletAddress,
  onSubmit,
}: {
  isBusy: boolean;
  isOpen: boolean;
  onClose: () => void;
  resolvedWalletLabel: string;
  walletAddress: string;
  onSubmit: (amount: string) => void;
}) {
  useEscapeKey(isOpen && !isBusy, onClose);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-8">
      <button
        type="button"
        aria-label="Close faucet modal"
        className="absolute inset-0 bg-black/35"
        onClick={onClose}
        disabled={isBusy}
      />

      <div className="relative z-10 w-full max-w-md rounded-2xl border border-[rgba(28,28,29,0.16)] bg-white p-6 shadow-lg">
        <p className="text-sm font-semibold text-[#1c1c1d]">Faucet</p>
        <p className="mt-1 text-sm text-[rgba(28,28,29,0.72)]">
          Request devnet SOL for{" "}
          <span className="font-medium text-[#1c1c1d]">{resolvedWalletLabel}</span>.
        </p>
        <p className="mt-2 font-mono text-xs text-[rgba(28,28,29,0.64)]">{walletAddress}</p>

        <form
          className="mt-5 grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const formData = new FormData(event.currentTarget);
            onSubmit(String(formData.get("amountSol") ?? ""));
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor={`wallet-faucet-amount-${walletIdFromAddress(walletAddress)}`}>
              Amount (SOL)
            </Label>
            <Input
              id={`wallet-faucet-amount-${walletIdFromAddress(walletAddress)}`}
              name="amountSol"
              type="number"
              inputMode="decimal"
              min="0.01"
              step="0.01"
              placeholder="1.00"
              required
              disabled={isBusy}
            />
            <p className="text-xs text-[rgba(28,28,29,0.64)]">
              Uses the configured devnet RPC relay to request an airdrop.
            </p>
          </div>

          <div className="mt-2 flex items-center justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={isBusy}>
              Cancel
            </Button>
            <Button type="submit" disabled={isBusy}>
              {isBusy ? "Requesting..." : "Request faucet"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function walletIdFromAddress(address: string): string {
  return address.replaceAll(/[^a-zA-Z0-9_-]/g, "");
}
