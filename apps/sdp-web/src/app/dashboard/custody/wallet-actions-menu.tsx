"use client";

import type { SolanaCluster } from "@sdp/types";
import {
  ArrowUpRight,
  ChevronDown,
  Droplets,
  Ellipsis,
  EllipsisVertical,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
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
import { explorerTxUrl } from "@/lib/explorer";
import { cn } from "@/lib/utils";

interface WalletActionsMenuProps {
  walletAddress: string;
  walletId: string;
  walletLabel: string | null;
  supportsSignerCheck?: boolean;
  triggerLabel?: string;
  /** `kebab` is the refresh wallet card's quiet vertical-dots trigger. */
  triggerMode?: "button" | "icon" | "kebab";
  triggerClassName?: string;
  /** Leads the menu with a link to the wallet, for surfaces that are not the wallet's own page. */
  openHref?: string;
}

/**
 * The faucet only funds devnet regardless of the project being viewed, so its
 * explorer link is pinned to devnet rather than following `useSolanaCluster()`
 * — using the active cluster would point a devnet signature at mainnet
 * explorer for anyone viewing a production project. (The signer check no
 * longer links anywhere: it is verified in simulation and never broadcast.)
 */
const ACTION_EXPLORER_CLUSTER = "devnet" satisfies SolanaCluster;

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
  openHref,
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
          // The check is verified in simulation and never broadcast, so there
          // is no on-chain transaction to link — an explorer URL for this
          // signature would always 404.
          toast.success(t("DashboardCustody.signerCheckSent"), {
            id: toastId,
            description: t("DashboardCustody.memoTransactionSubmitted"),
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
            message:
              error instanceof Error ? error.message : t("DashboardCustody.devnetFaucetFailed"),
          })
        );

        if (result.status === "success") {
          const explorerUrl = explorerTxUrl(result.signature, ACTION_EXPLORER_CLUSTER);

          toast.success(t("DashboardCustody.devnetSolRequested", { amount: result.amountSol }), {
            id: toastId,
            description: (
              <span>
                {t("DashboardCustody.faucetTransactionSubmitted")}{" "}
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
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        {triggerMode === "button" ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className={cn("whitespace-nowrap", triggerClassName)}
            iconRight={<ChevronDown className="size-4" />}
            aria-label={t("DashboardCustody.walletActionsFor", { wallet: resolvedWalletLabel })}
            disabled={isBusy}
          >
            {resolvedTriggerLabel}
          </Button>
        ) : (
          <Button
            type="button"
            variant={triggerMode === "kebab" ? "ghost" : "outline"}
            size="icon-sm"
            className={triggerClassName}
            aria-label={t("DashboardCustody.walletActionsFor", { wallet: resolvedWalletLabel })}
            disabled={isBusy}
          >
            {triggerMode === "kebab" ? (
              <EllipsisVertical className="size-4.5" />
            ) : (
              <Ellipsis className="h-4 w-4" />
            )}
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {openHref ? (
          <>
            <DropdownMenuItem asChild>
              <Link href={openHref}>
                <ArrowUpRight className="h-4 w-4" />
                {t("DashboardCustody.openWallet")}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
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
