"use client";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@sdp/ui/tooltip";
import { TriangleAlertIcon } from "lucide-react";
import type { ResolvedTokenPresentation } from "@/app/dashboard/[projectId]/payments/payments-overview.utils";
import { useTranslations } from "@/i18n/provider";

/**
 * Whether a token's name is the symbol its own mint metadata declares, which anyone creating a
 * mint can set, rather than a well-known or project-issued token's label.
 *
 * @param resolved - The token as `resolveTokenByMint` named it.
 * @param tokenSymbol - The row's metadata symbol, when the API resolved one.
 * @returns True when the name shown is only the mint's self-declared symbol.
 */
export function isUnverifiedMintName(
  resolved: ResolvedTokenPresentation,
  tokenSymbol: string | undefined
): boolean {
  return tokenSymbol !== undefined && !resolved.isWellKnown && resolved.tokenId === null;
}

/** A warning beside a token name that only the mint's own metadata vouches for. */
export function UnverifiedMintWarning() {
  const t = useTranslations();
  const text = t("DashboardPayments.transactions.unverifiedMint");
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" aria-label={text} className="inline-flex shrink-0 text-warning">
            <TriangleAlertIcon className="size-3.5" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-64 text-xs">
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
