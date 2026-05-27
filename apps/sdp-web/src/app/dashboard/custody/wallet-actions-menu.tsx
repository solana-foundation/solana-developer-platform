"use client";

import { ChevronDown, Droplets, Ellipsis, ShieldCheck } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";
import {
  checkWalletSignerMemoAction,
  requestDevnetSolanaFaucetAction,
} from "@/app/dashboard/custody/actions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { cn } from "@/lib/utils";

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
  const { dashboardAccess, sandboxProject } = useDashboardWorkspace();
  const [isBusy, startTransition] = useTransition();
  const resolvedWalletLabel = formatWalletLabel(walletLabel, walletAddress);

  const runSignerCheck = () => {
    if (!sandboxProject) {
      toast.error("Sandbox project unavailable. Reload the dashboard and try again.", {
        position: "bottom-right",
      });
      return;
    }

    const toastId = toast.loading("Sending signer check.", {
      position: "bottom-right",
    });

    startTransition(() => {
      void (async () => {
        const result = await checkWalletSignerMemoAction(walletId).catch((error) => ({
          status: "error" as const,
          message: error instanceof Error ? error.message : "Signer check failed.",
        }));

        if (result.status === "success") {
          const explorerUrl = getDevnetExplorerUrl(result.signature);

          toast.success("Signer check sent.", {
            id: toastId,
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
          id: toastId,
          description: result.message,
          position: "bottom-right",
        });
      })();
    });
  };

  const requestDevnetSol = () => {
    const toastId = toast.loading("Requesting devnet SOL.", {
      position: "bottom-right",
    });

    startTransition(() => {
      void (async () => {
        const result = await requestDevnetSolanaFaucetAction(walletId, walletAddress).catch(
          (error) => ({
            status: "error" as const,
            message: error instanceof Error ? error.message : "Devnet faucet failed.",
          })
        );

        if (result.status === "success") {
          const explorerUrl = getDevnetExplorerUrl(result.signature);

          toast.success(`${result.amountSol} devnet SOL requested.`, {
            id: toastId,
            description: (
              <span>
                Faucet transaction submitted.{" "}
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

        toast.error("Devnet faucet failed.", {
          id: toastId,
          description: result.message,
          position: "bottom-right",
        });
      })();
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {triggerMode === "button" ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className={cn("min-w-[132px] whitespace-nowrap", triggerClassName)}
            iconRight={<ChevronDown className="size-4" />}
            aria-label={`Wallet actions for ${resolvedWalletLabel}`}
            disabled={isBusy}
          >
            {triggerLabel}
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
      <DropdownMenuContent align="end" className="w-52">
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
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={requestDevnetSol} disabled={isBusy}>
          <Droplets className="h-4 w-4" />
          {isBusy ? "Requesting..." : "Request devnet SOL"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
