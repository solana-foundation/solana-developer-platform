"use client";

import { ArrowRight, ChevronDown, MoreHorizontal, Plus } from "lucide-react";
import { AnimatePresence, useReducedMotion } from "motion/react";
import { useState } from "react";
import { DashboardNavigationLink as Link } from "@/components/dashboard-navigation-link";
import { Badge } from "@/components/ui/badge";
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
  type FieldDepth,
  FieldRow,
  formatDate,
  formatSupply,
  getDeploymentStatus,
  getTokenChips,
  type IssuanceTokenView,
  type ManageVariant,
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

// Kebab (⋯) menu — Manage plus quick actions. Copy uses the clipboard API.
function ManageKebab({ token }: { token: IssuanceTokenView }) {
  const t = useTranslations();
  const explorer = tokenExplorerHref(token.mintAddress);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label={t("DashboardIssuance.workspace.manage")}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem asChild>
          <Link href={detailHref(token)}>{t("DashboardIssuance.workspace.manage")}</Link>
        </DropdownMenuItem>
        {(explorer || token.mintAddress) && <DropdownMenuSeparator />}
        {explorer ? (
          <DropdownMenuItem asChild>
            <a href={explorer} target="_blank" rel="noreferrer">
              {t("DashboardIssuance.list.viewOnExplorer")}
            </a>
          </DropdownMenuItem>
        ) : null}
        {token.mintAddress ? (
          <DropdownMenuItem
            onSelect={() => {
              if (token.mintAddress) {
                void navigator.clipboard?.writeText(token.mintAddress);
              }
            }}
          >
            {t("DashboardIssuance.list.copyMintAddress")}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The Manage action, rendered per selected variant. `context` tunes placement:
// "row"/"tile" sit alongside the collapsed content; "tile" also handles the grid
// card footer. The "link" variant is intentionally quiet — in a row it defers to
// the expanded panel's inline link (returns null here).
export function ManageAffordance({
  token,
  variant,
  context,
}: {
  token: IssuanceTokenView;
  variant: ManageVariant;
  context: "row" | "tile";
}) {
  const t = useTranslations();

  if (variant === "kebab") {
    return <ManageKebab token={token} />;
  }

  if (variant === "button") {
    return (
      <Button type="button" asChild variant="outline" size="sm" className="h-8 shrink-0 rounded-lg">
        <Link href={detailHref(token)}>
          {t("DashboardIssuance.workspace.manage")}
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </Button>
    );
  }

  // variant === "link"
  if (context === "tile") {
    return (
      <Link
        href={detailHref(token)}
        className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
      >
        {t("DashboardIssuance.workspace.manage")}
        <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    );
  }
  return null;
}

function CollapsedStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-right">
      <p className="text-xs text-tertiary">{label}</p>
      <p className="text-sm font-medium text-primary">{value}</p>
    </div>
  );
}

function IssuanceTokenListRow({
  token,
  manageVariant,
  fieldDepth,
}: {
  token: IssuanceTokenView;
  manageVariant: ManageVariant;
  fieldDepth: FieldDepth;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const reduceMotion = useReducedMotion();
  const [expanded, setExpanded] = useState(false);
  const chips = getTokenChips(token, t);
  const fields = expanded ? buildExpandedFields(token, fieldDepth, t, locale) : [];

  return (
    <div
      data-testid={`token-row-${token.id}`}
      className="overflow-hidden rounded-2xl border border-border-default bg-surface-raised"
    >
      <div className="flex items-center gap-3 p-4">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
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
          <div className="ml-1 hidden flex-wrap items-center gap-1.5 md:flex">
            {chips.map((chip) => {
              const Icon = chip.icon;
              return (
                <Badge key={chip.label} variant="default" className="gap-1">
                  {Icon ? <Icon className="h-3 w-3" aria-hidden="true" /> : null}
                  {chip.label}
                </Badge>
              );
            })}
          </div>
          <div className="ml-auto hidden items-center gap-8 lg:flex">
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
          </div>
          <div className="ml-auto lg:ml-4">
            <StatusBadge token={token} />
          </div>
        </button>
        <ManageAffordance token={token} variant={manageVariant} context="row" />
      </div>

      <AnimatePresence initial={false}>
        {expanded ? (
          <HeightReveal key="panel" durationSeconds={reduceMotion ? 0 : 0.28}>
            <div className="border-t border-border-subtle bg-fill-subtle px-5 py-5">
              <div className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3">
                {fields.map((field) => (
                  <FieldRow key={field.label} {...field} />
                ))}
              </div>
              {manageVariant === "link" ? (
                <div className="mt-5 flex justify-end border-t border-border-subtle pt-4">
                  <Link
                    href={detailHref(token)}
                    className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                  >
                    {t("DashboardIssuance.list.manageThisAsset")}
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </div>
              ) : null}
            </div>
          </HeightReveal>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export function IssuanceTokenList({
  tokens,
  manageVariant,
  fieldDepth,
  onCreate,
}: {
  tokens: IssuanceTokenView[];
  manageVariant: ManageVariant;
  fieldDepth: FieldDepth;
  onCreate: () => void;
}) {
  const t = useTranslations();

  return (
    <div className="flex flex-col gap-2.5">
      {tokens.map((token) => (
        <IssuanceTokenListRow
          key={token.id}
          token={token}
          manageVariant={manageVariant}
          fieldDepth={fieldDepth}
        />
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
