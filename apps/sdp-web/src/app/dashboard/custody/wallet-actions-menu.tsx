"use client";

import { checkWalletSignerMemoAction } from "@/app/dashboard/custody/actions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { cn } from "@/lib/utils";
import { ChevronDown, Ellipsis, ShieldCheck } from "lucide-react";
import { useTransition } from "react";
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

  return (
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
  );
}
