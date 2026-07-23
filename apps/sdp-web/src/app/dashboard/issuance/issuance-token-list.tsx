"use client";

import {
  ArrowRight,
  ChevronDown,
  Copy,
  ExternalLink,
  type LucideIcon,
  MoreHorizontal,
  Plus,
  SlidersHorizontal,
  Terminal,
} from "lucide-react";
import { AnimatePresence, useReducedMotion } from "motion/react";
import { useState } from "react";
import { toast } from "sonner";
import { DashboardNavigationLink as Link } from "@/components/dashboard-navigation-link";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HeightReveal } from "@/components/ui/height-reveal";
import { useLocale, useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import {
  buildExpandedFields,
  FieldRow,
  formatDate,
  formatSupply,
  getDeploymentStatus,
  getTokenChips,
  type IssuanceTokenView,
  tokenExplorerHref,
} from "./issuance-token-fields";

function detailHref(token: IssuanceTokenView): string {
  return `/dashboard/issuance/${token.id}`;
}

function TokenAvatar({ token, size = 40 }: { token: IssuanceTokenView; size?: number }) {
  const t = useTranslations();
  return (
    <div
      className="shrink-0 overflow-hidden rounded-full border border-border-default bg-[white]"
      style={{ height: size, width: size }}
    >
      {token.imageUrl ? (
        // biome-ignore lint/performance/noImgElement: user-supplied external logo URL; next/image can't be configured for arbitrary hosts here.
        <img
          src={token.imageUrl}
          alt={t("DashboardIssuance.workspace.tokenLogo", { name: token.name })}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-sm font-semibold text-tertiary">
          {token.symbol.slice(0, 1) || "?"}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ token }: { token: IssuanceTokenView }) {
  const t = useTranslations();
  const status = getDeploymentStatus(token);
  return (
    <span
      data-testid={`token-row-status-${token.id}`}
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-medium capitalize",
        status === "active" ? "bg-success-bg text-success" : "bg-fill text-secondary"
      )}
    >
      {status === "active"
        ? t("DashboardIssuance.workspace.active")
        : t("DashboardIssuance.workspace.draft")}
    </span>
  );
}

// Actions menu — Manage, playground deep-link, and quick actions. Copy uses the
// clipboard API. Reused by the list row (default ghost ⋯ trigger) and the grid
// tile, which passes a manage glyph via `icon` and `triggerVariant="outline"` so
// the corner action reads as a defined button rather than a floating icon.
export function ManageKebab({
  token,
  icon: Icon = MoreHorizontal,
  triggerVariant = "ghost",
}: {
  token: IssuanceTokenView;
  icon?: LucideIcon;
  triggerVariant?: "ghost" | "outline";
}) {
  const t = useTranslations();
  const explorer = tokenExplorerHref(token.mintAddress);
  const playgroundHref = `/dashboard/issuance?tab=playground&tokenId=${encodeURIComponent(token.id)}`;

  const handleCopyMintAddress = async () => {
    if (!token.mintAddress) return;
    try {
      await navigator.clipboard.writeText(token.mintAddress);
      toast.success(t("DashboardIssuance.list.copied"));
    } catch {
      toast.error(t("DashboardIssuance.list.unableToCopy"));
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={triggerVariant}
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label={t("DashboardIssuance.workspace.manage")}
        >
          <Icon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem asChild>
          <Link href={detailHref(token)}>
            <SlidersHorizontal className="h-4 w-4 shrink-0 text-tertiary" aria-hidden="true" />
            {t("DashboardIssuance.workspace.manage")}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={playgroundHref}>
            <Terminal className="h-4 w-4 shrink-0 text-tertiary" aria-hidden="true" />
            {t("DashboardIssuance.playground.openInPlayground")}
          </Link>
        </DropdownMenuItem>
        {(explorer || token.mintAddress) && <DropdownMenuSeparator />}
        {explorer ? (
          <DropdownMenuItem asChild>
            <a href={explorer} target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4 shrink-0 text-tertiary" aria-hidden="true" />
              {t("DashboardIssuance.list.viewOnExplorer")}
            </a>
          </DropdownMenuItem>
        ) : null}
        {token.mintAddress ? (
          <DropdownMenuItem onSelect={() => void handleCopyMintAddress()}>
            <Copy className="h-4 w-4 shrink-0 text-tertiary" aria-hidden="true" />
            {t("DashboardIssuance.list.copyMintAddress")}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CollapsedStat({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={cn("hidden min-w-0 text-center lg:block", className)}>
      <p className="truncate text-xs text-tertiary">{label}</p>
      <p className="truncate text-sm font-medium text-primary">{value}</p>
    </div>
  );
}

function IssuanceTokenListRow({ token }: { token: IssuanceTokenView }) {
  const t = useTranslations();
  const locale = useLocale();
  const reduceMotion = useReducedMotion();
  const [expanded, setExpanded] = useState(false);
  const chips = getTokenChips(token, t);
  const fields = expanded ? buildExpandedFields(token, t, locale) : [];

  const toggle = () => setExpanded((value) => !value);

  return (
    <div
      data-testid={`token-row-${token.id}`}
      className="overflow-hidden rounded-2xl border border-border-default bg-surface-raised"
    >
      {/* The whole header row toggles the panel via a full-bleed overlay button
          (a real <button> covering the row). The kebab cell sits above it (z-10)
          so its menu is clickable without also toggling the row. */}
      <div
        className={cn(
          "relative grid items-center gap-x-3 p-4 text-left",
          "grid-cols-[auto_auto_minmax(0,1fr)_auto_auto]",
          "md:grid-cols-[auto_auto_auto_minmax(0,1fr)_auto_auto]",
          "lg:grid-cols-[auto_auto_11rem_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_5rem_auto]"
        )}
      >
        <button
          type="button"
          onClick={toggle}
          aria-expanded={expanded}
          aria-label={t("DashboardIssuance.list.toggleDetails", { name: token.name })}
          className="absolute inset-0 z-0 cursor-pointer rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-[var(--button-focus-ring)] focus-visible:ring-inset"
        />
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-tertiary transition-transform duration-200",
            expanded && "rotate-180"
          )}
          aria-hidden="true"
        />
        <TokenAvatar token={token} />
        <div className="min-w-0">
          <p className="text-xs font-medium tracking-wide text-tertiary">{token.symbol}</p>
          <p className="truncate text-sm font-medium text-primary">{token.name}</p>
        </div>
        {/* Chips are stacked one-per-row so every row is the same height. */}
        <div className="hidden min-w-0 flex-col items-start gap-1 md:flex">
          {chips.map((chip) => {
            const Icon = chip.icon;
            return (
              <span
                key={chip.label}
                className="inline-flex max-w-full items-center gap-1 rounded-full border border-border-subtle bg-fill-subtle px-2 py-0.5 text-xs text-secondary"
              >
                {Icon ? (
                  <Icon className="h-3.5 w-3.5 shrink-0 text-tertiary" aria-hidden="true" />
                ) : null}
                <span className="truncate">{chip.label}</span>
              </span>
            );
          })}
        </div>
        <CollapsedStat
          label={t("DashboardIssuance.workspace.supply")}
          value={formatSupply(token.totalSupply, locale)}
        />
        <CollapsedStat
          label={t("DashboardIssuance.list.decimals")}
          value={String(token.decimals)}
        />
        <CollapsedStat
          label={t("DashboardIssuance.workspace.created")}
          value={formatDate(token.createdAt, locale)}
        />
        <div className="flex justify-end">
          <StatusBadge token={token} />
        </div>
        <div className="relative z-10 flex justify-end">
          <ManageKebab token={token} />
        </div>
      </div>

      <AnimatePresence initial={false}>
        {expanded ? (
          <HeightReveal key="panel" durationSeconds={reduceMotion ? 0 : 0.28}>
            <div className="border-t border-border-subtle bg-surface-raised px-5 py-5">
              <div className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3">
                {fields.map((field) => (
                  <FieldRow key={field.label} {...field} />
                ))}
              </div>
              <div className="mt-5 flex justify-end border-t border-border-subtle pt-4">
                <Link
                  href={detailHref(token)}
                  className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                >
                  {t("DashboardIssuance.list.manageThisAsset")}
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            </div>
          </HeightReveal>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export function IssuanceTokenList({
  tokens,
  onCreate,
}: {
  tokens: IssuanceTokenView[];
  onCreate: () => void;
}) {
  const t = useTranslations();

  return (
    <div className="flex flex-col gap-2.5">
      {tokens.map((token) => (
        <IssuanceTokenListRow key={token.id} token={token} />
      ))}
      <button
        type="button"
        onClick={onCreate}
        data-testid="token-add-row"
        className="flex items-center justify-center gap-2 rounded-2xl border border-dashed border-border-strong bg-surface-raised py-3.5 text-sm font-medium text-tertiary transition-colors hover:border-primary/40 hover:text-secondary"
      >
        <Plus className="h-4 w-4" />
        {t("DashboardIssuance.workspace.createDraft")}
      </button>
    </div>
  );
}
