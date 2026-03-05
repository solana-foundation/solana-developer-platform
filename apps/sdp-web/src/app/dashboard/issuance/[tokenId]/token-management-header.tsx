"use client";

import { Button } from "@/components/ui/button";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import Link from "next/link";
import type { AdminAction } from "./token-management-workspace.types";

interface TokenManagementHeaderProps {
  tokenName: string;
  tokenSymbol: string;
  explorerHref: string | null;
  canDeployToken: boolean;
  isPending: boolean;
  isActionMenuOpen: boolean;
  onActionMenuToggle: () => void;
  onActionMenuClose: () => void;
  onSelectAction: (action: AdminAction) => void;
  onDeploy: () => void;
}

export function TokenManagementHeader({
  tokenName,
  tokenSymbol,
  explorerHref,
  canDeployToken,
  isPending,
  isActionMenuOpen,
  onActionMenuToggle,
  onActionMenuClose,
  onSelectAction,
  onDeploy,
}: TokenManagementHeaderProps) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-[rgba(28,28,29,0.14)] bg-white text-[18px] font-semibold text-[rgba(28,28,29,0.66)]">
          {tokenSymbol.slice(0, 1) || "T"}
        </div>
        <div className="min-w-0">
          <h2 className="truncate text-[30px] leading-[1.1] font-medium text-[#1c1c1d]">
            {tokenName}
          </h2>
          <p className="truncate text-[17px] text-[rgba(28,28,29,0.66)]">{tokenSymbol}</p>
        </div>
      </div>

      <div className="relative z-30 flex items-center gap-2">
        {explorerHref ? (
          <Button variant="outline" asChild>
            <Link href={explorerHref} target="_blank" rel="noopener noreferrer">
              Explorer
              <ArrowUpRight className="h-4 w-4" />
            </Link>
          </Button>
        ) : (
          <Button variant="outline" disabled>
            Explorer
          </Button>
        )}
        <Button type="button" variant="secondary" onClick={onActionMenuToggle}>
          Admin Actions
          <ChevronDown className="h-4 w-4" />
        </Button>

        {isActionMenuOpen ? (
          <>
            <button
              type="button"
              aria-label="Close admin actions menu"
              className="fixed inset-0 z-20 cursor-default bg-transparent"
              onClick={onActionMenuClose}
            />
            <div className="absolute top-[44px] right-0 z-30 w-[260px] overflow-hidden rounded-xl border border-[rgba(28,28,29,0.12)] bg-white shadow-[0_14px_28px_rgba(28,28,29,0.16)]">
              <div className="border-b border-[rgba(28,28,29,0.08)] px-3 py-2 text-xs font-medium tracking-wide text-[rgba(28,28,29,0.6)] uppercase">
                Token Actions
              </div>
              <div className="p-1">
                <MenuAction label="Mint Tokens" onClick={() => onSelectAction("mint")} />
                <MenuAction label="Burn Tokens" onClick={() => onSelectAction("burn")} />
                <MenuAction
                  label="Update Metadata"
                  onClick={() => onSelectAction("update-metadata")}
                />
                <MenuAction
                  label="Refresh Supply"
                  onClick={() => onSelectAction("refresh-supply")}
                />
              </div>
              <div className="border-y border-[rgba(28,28,29,0.08)] px-3 py-2 text-xs font-medium tracking-wide text-[rgba(28,28,29,0.6)] uppercase">
                Administrative
              </div>
              <div className="p-1">
                <button
                  type="button"
                  onClick={onDeploy}
                  disabled={!canDeployToken || isPending}
                  className={[
                    "flex w-full items-center rounded-lg px-3 py-2 text-left text-sm",
                    canDeployToken
                      ? "hover:bg-[rgba(28,28,29,0.05)]"
                      : "cursor-not-allowed text-[rgba(28,28,29,0.42)] opacity-60",
                  ].join(" ")}
                >
                  Deploy Token
                </button>
                <MenuAction label="Force Transfer" onClick={() => onSelectAction("seize")} />
                <MenuAction label="Force Burn" onClick={() => onSelectAction("force-burn")} />
                <MenuAction
                  label="Freeze / Unfreeze Account"
                  onClick={() => onSelectAction("freeze")}
                />
                <MenuAction label="Pause / Unpause Token" onClick={() => onSelectAction("pause")} />
                <MenuAction label="Update Authority" onClick={() => onSelectAction("authority")} />
                <MenuAction label="Manage Allowlist" onClick={() => onSelectAction("allowlist")} />
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function MenuAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center rounded-lg px-3 py-2 text-left text-sm hover:bg-[rgba(28,28,29,0.05)]"
    >
      {label}
    </button>
  );
}
