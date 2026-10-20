"use client";

import { Button } from "@sdp/ui/button";
import { cn } from "@sdp/ui/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@sdp/ui/dropdown-menu";
import { ArrowUpRight, ChevronDown, Ellipsis, EllipsisVertical, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { DevnetSolMenuItem } from "@/app/dashboard/[projectId]/custody/devnet-sol-menu-item";
import { useWalletActions } from "@/app/dashboard/[projectId]/custody/use-wallet-actions";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";

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
  const { dashboardAccess } = useDashboardWorkspace();
  const { isBusy, canRunSignerCheck, runSignerCheck, canRequestDevnetSol, requestDevnetSol } =
    useWalletActions({
      walletId,
      supportsSignerCheck,
    });
  const resolvedWalletLabel = formatWalletLabel(walletLabel, walletAddress);
  const resolvedTriggerLabel = triggerLabel ?? t("DashboardCustody.actions");

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
        <DevnetSolMenuItem
          isBusy={isBusy}
          canRequest={canRequestDevnetSol}
          onSelect={requestDevnetSol}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
