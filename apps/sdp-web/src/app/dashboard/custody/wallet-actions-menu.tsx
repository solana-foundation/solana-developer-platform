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
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";

interface WalletActionsMenuProps {
  walletAddress: string;
  walletId: string;
  walletLabel: string | null;
  supportsSignerCheck?: boolean;
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
  supportsSignerCheck = true,
  triggerLabel,
  triggerMode = "icon",
  triggerClassName,
}: WalletActionsMenuProps) {
  const t = useTranslations();
  const { dashboardAccess, sandboxProject } = useDashboardWorkspace();
  const [isBusy, startTransition] = useTransition();
  const resolvedWalletLabel = formatWalletLabel(walletLabel, walletAddress);
  const resolvedTriggerLabel = triggerLabel ?? t("DashboardCustody.actions");
  const canRunSignerCheck =
    supportsSignerCheck && dashboardAccess.capabilities.canUseWalletSignerCheck;

  const runSignerCheck = () => {
    if (!sandboxProject) {
      toast.error(t("DashboardCustody.sandboxProjectUnavailable"), {
        position: "bottom-right",
      });
      return;
    }

    const toastId = toast.loading(t("DashboardCustody.sendingSignerCheck"), {
      position: "bottom-right",
    });

    startTransition(() => {
      void (async () => {
        const result = await checkWalletSignerMemoAction(walletId).catch((error) => ({
          status: "error" as const,
          message: error instanceof Error ? error.message : t("DashboardCustody.signerCheckFailed"),
        }));

        if (result.status === "success") {
          const explorerUrl = getDevnetExplorerUrl(result.signature);

          toast.success(t("DashboardCustody.signerCheckSent"), {
            id: toastId,
            description: (
              <span>
                {t("DashboardCustody.memoTransactionSubmitted")} {" "}
                <a
                  href={explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2"
                >
                  {t("DashboardCustody.viewOnSolanaExplorer")}
                </a>
              </span>
            ),
            position: "bottom-right",
          });
          return;
        }

        toast.error(t("DashboardCustody.signerCheckFailed"), {
          id: toastId,
          description: result.message,
          position: "bottom-right",
        });
      })();
    });
  };

  const requestDevnetSol = () => {
    const toastId = toast.loading(t("DashboardCustody.requestingDevnetSol"), {
      position: "bottom-right",
    });

    startTransition(() => {
      void (async () => {
        const result = await requestDevnetSolanaFaucetAction(walletId, walletAddress).catch(
          (error) => ({
            status: "error" as const,
            message: error instanceof Error ? error.message : t("DashboardCustody.devnetFaucetFailed"),
          })
        );

        if (result.status === "success") {
          const explorerUrl = getDevnetExplorerUrl(result.signature);

          toast.success(t("DashboardCustody.devnetSolRequested", { amount: result.amountSol }), {
            id: toastId,
            description: (
              <span>
                {t("DashboardCustody.faucetTransactionSubmitted")} {" "}
                <a
                  href={explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2"
                >
                  {t("DashboardCustody.viewOnSolanaExplorer")}
                </a>
              </span>
            ),
            position: "bottom-right",
          });
          return;
        }

        toast.error(t("DashboardCustody.devnetFaucetFailed"), {
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
            aria-label={t("DashboardCustody.walletActionsFor", { wallet: resolvedWalletLabel })}
            disabled={isBusy}
          >
            {resolvedTriggerLabel}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className={triggerClassName}
            aria-label={t("DashboardCustody.walletActionsFor", { wallet: resolvedWalletLabel })}
            disabled={isBusy}
          >
            <Ellipsis className="h-4 w-4" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onSelect={runSignerCheck} disabled={isBusy || !canRunSignerCheck}>
          <ShieldCheck className="h-4 w-4" />
          {isBusy
            ? t("DashboardCustody.proving")
            : !supportsSignerCheck
              ? t("DashboardCustody.proveOwnershipUnsupported")
              : dashboardAccess.capabilities.canUseWalletSignerCheck
                ? t("DashboardCustody.proveOwnership")
                : t("DashboardCustody.proveOwnershipAdminOnly")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={requestDevnetSol} disabled={isBusy}>
          <Droplets className="h-4 w-4" />
          {isBusy ? t("DashboardCustody.requesting") : t("DashboardCustody.requestDevnetSol")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
