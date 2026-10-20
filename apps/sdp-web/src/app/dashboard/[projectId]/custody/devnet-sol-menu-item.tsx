"use client";

import { DropdownMenuItem } from "@sdp/ui/dropdown-menu";
import { Droplets } from "lucide-react";
import { useTranslations } from "@/i18n/provider";

type DevnetSolItemState = "requesting" | "available" | "adminOnly";

/** The wallet menus' faucet item: disabled while a request runs, and for a member (admin only). */
export function DevnetSolMenuItem({
  isBusy,
  canRequest,
  onSelect,
}: {
  isBusy: boolean;
  canRequest: boolean;
  onSelect: () => void;
}) {
  const t = useTranslations();
  const state = devnetSolItemState(isBusy, canRequest);
  return (
    <DropdownMenuItem onSelect={onSelect} disabled={state !== "available"}>
      <Droplets className="h-4 w-4" />
      {devnetSolLabel(state, t)}
    </DropdownMenuItem>
  );
}

function devnetSolItemState(isBusy: boolean, canRequest: boolean): DevnetSolItemState {
  if (isBusy) return "requesting";
  if (!canRequest) return "adminOnly";
  return "available";
}

function devnetSolLabel(state: DevnetSolItemState, t: ReturnType<typeof useTranslations>): string {
  switch (state) {
    case "requesting":
      return t("DashboardCustody.requesting");
    case "available":
      return t("DashboardCustody.requestDevnetSol");
    case "adminOnly":
      return t("DashboardCustody.requestDevnetSolAdminOnly");
    default: {
      const unhandledState: never = state;
      throw new Error(`Unhandled devnet SOL item state: ${String(unhandledState)}`);
    }
  }
}
