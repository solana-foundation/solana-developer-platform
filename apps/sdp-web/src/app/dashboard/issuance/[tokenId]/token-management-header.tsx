"use client";

import { ArrowUpRight, Copy } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { TokenDisabledActionTooltip } from "./token-disabled-action-tooltip";

interface TokenManagementHeaderProps {
  tokenId: string;
  tokenName: string;
  tokenSymbol: string;
  tokenStatus: "pending" | "active" | "paused" | "revoked";
  tokenAddress: string | null;
  tokenImageUrl: string | null;
  explorerHref: string | null;
  canDeployToken: boolean;
  canManageTokenAdmin: boolean;
  isPending: boolean;
  deployDisabledReason?: string | null;
  pauseDisabledReason?: string | null;
  onCopyAddress: () => void;
  onCopyTokenId: () => void;
  onDeploy: () => void;
  onUnpause: () => void;
}

export function TokenManagementHeader({
  tokenId,
  tokenName,
  tokenSymbol,
  tokenStatus,
  tokenAddress,
  tokenImageUrl,
  explorerHref,
  canDeployToken,
  canManageTokenAdmin,
  isPending,
  deployDisabledReason,
  pauseDisabledReason,
  onCopyAddress,
  onCopyTokenId,
  onDeploy,
  onUnpause,
}: TokenManagementHeaderProps) {
  const tokenAddressLabel = tokenAddress
    ? `${tokenAddress.slice(0, 5)}...${tokenAddress.slice(-4)}`
    : "Not deployed";

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          {tokenImageUrl ? (
            <img
              src={tokenImageUrl}
              alt={tokenName}
              className="h-14 w-14 shrink-0 rounded-full border border-[rgba(28,28,29,0.12)] object-cover"
            />
          ) : (
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border border-[rgba(28,28,29,0.14)] bg-white text-[20px] font-semibold text-[#1c1c1d]">
              {tokenSymbol.slice(0, 1) || "T"}
            </div>
          )}

          <div className="min-w-0">
            <h2 className="truncate text-[42px] leading-[1.02] font-medium tracking-[-0.5px] text-[#1c1c1d]">
              {tokenName}
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[18px] text-[rgba(28,28,29,0.68)]">
              <span className="font-mono text-[15px] tracking-[-0.1px]">{tokenAddressLabel}</span>
              {tokenAddress ? (
                <button
                  type="button"
                  onClick={onCopyAddress}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-[10px] border border-[rgba(28,28,29,0.12)] bg-white text-[rgba(28,28,29,0.62)] transition-colors hover:text-[#1c1c1d]"
                  aria-label="Copy token address"
                >
                  <Copy className="h-4 w-4" />
                </button>
              ) : null}
              <span className="rounded-full border border-[rgba(28,28,29,0.1)] bg-white px-3 py-1 text-[13px] font-medium text-[rgba(28,28,29,0.62)]">
                {tokenSymbol}
              </span>
            </div>
            <div
              className="mt-2 flex flex-wrap items-center gap-2 text-[14px] text-[rgba(28,28,29,0.68)]"
              data-testid="token-id-row"
            >
              <span className="text-[13px] font-medium tracking-[-0.1px] text-[rgba(28,28,29,0.54)]">
                Token ID:
              </span>
              <span className="font-mono text-[13px] tracking-[-0.1px]">{tokenId}</span>
              <button
                type="button"
                onClick={onCopyTokenId}
                className="inline-flex h-7 w-7 items-center justify-center rounded-[10px] border border-[rgba(28,28,29,0.12)] bg-white text-[rgba(28,28,29,0.62)] transition-colors hover:text-[#1c1c1d]"
                aria-label="Copy token ID"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {explorerHref ? (
            <Button variant="outline" asChild>
              <Link href={explorerHref} target="_blank" rel="noopener noreferrer">
                Explorer
                <ArrowUpRight className="h-4 w-4" />
              </Link>
            </Button>
          ) : null}

          {canDeployToken ? (
            <TokenDisabledActionTooltip reason={isPending ? null : deployDisabledReason}>
              <Button
                type="button"
                onClick={onDeploy}
                disabled={isPending || Boolean(deployDisabledReason)}
              >
                Deploy
              </Button>
            </TokenDisabledActionTooltip>
          ) : (
            <>
              {tokenStatus === "paused" && canManageTokenAdmin ? (
                <TokenDisabledActionTooltip reason={isPending ? null : pauseDisabledReason}>
                  <Button
                    type="button"
                    onClick={onUnpause}
                    disabled={isPending || Boolean(pauseDisabledReason)}
                  >
                    Unpause
                  </Button>
                </TokenDisabledActionTooltip>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
