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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

// ─────────────────────────────────────────────────────────────────────────────
// Composite-only reveal.
// A row's detail panel is rendered ABSOLUTELY (so it never contributes to layout)
// and pre-mounted for every row, then faded in/out with opacity. Opening a row
// pushes the rows below it by translating them with `transform` — never by
// relayout — so the motion is pure compositor work (no per-frame Layout/Paint,
// which profiling showed was the source of the dropped frames). Panels are
// measured up front so the slide starts on the click frame (no rAF / measure
// round-trip), and every row is its own layer (`will-change: transform`) so no
// layer is created mid-interaction. Supports multiple rows open at once: each row
// is offset by the summed height of every open panel above it.
// ─────────────────────────────────────────────────────────────────────────────

const ANIM_MS = 250;
const ROW_GAP_PX = 10; // matches the flex `gap-2.5`

function detailHref(token: IssuanceTokenView): string {
  return `/dashboard/issuance/${token.id}`;
}

function TokenAvatar({ token, size = 40 }: { token: IssuanceTokenView; size?: number }) {
  const t = useTranslations();
  return (
    <div
      className="shrink-0 overflow-hidden rounded-full border border-border-default bg-fill-subtle"
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
      <p className="truncate text-sm font-normal text-primary">{value}</p>
    </div>
  );
}

function IssuanceTokenListRow({
  token,
  open,
  offset,
  onToggle,
  onHeight,
}: {
  token: IssuanceTokenView;
  open: boolean;
  offset: number;
  onToggle: () => void;
  onHeight: (id: string, height: number) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const chips = getTokenChips(token, t);
  const panelRef = useRef<HTMLDivElement>(null);

  // Fields are static per token; build once so re-renders (offset changes) don't
  // recompute them.
  const fields = useMemo(() => buildExpandedFields(token, t, locale), [token, t, locale]);

  // Measure the (always-mounted) panel up front and keep it current, so the list
  // knows how far to push the rows below the instant a row is toggled.
  useEffect(() => {
    const el = panelRef.current;
    if (!el) {
      return;
    }
    onHeight(token.id, el.offsetHeight);
    const observer = new ResizeObserver(() => onHeight(token.id, el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [token.id, onHeight]);

  return (
    <div
      className="relative"
      style={{
        transform: `translateY(${offset}px)`,
        transition: `transform ${ANIM_MS}ms ease-out`,
        willChange: "transform",
        // Open rows sit beneath their siblings; closed rows above them.
        zIndex: open ? 0 : 1,
      }}
    >
      <div
        data-testid={`token-row-${token.id}`}
        className="overflow-hidden rounded-2xl border border-border-default bg-surface-raised"
      >
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
            onClick={onToggle}
            aria-expanded={open}
            aria-label={t("DashboardIssuance.list.toggleDetails", { name: token.name })}
            className="absolute inset-0 z-0 cursor-pointer rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-[var(--button-focus-ring)] focus-visible:ring-inset"
          />
          <ChevronDown
            className={cn(
              "h-4 w-4 shrink-0 text-tertiary transition-transform duration-200",
              open && "rotate-180"
            )}
            aria-hidden="true"
          />
          <TokenAvatar token={token} />
          <div className="min-w-0">
            <p className="text-xs font-medium tracking-wide text-tertiary">{token.symbol}</p>
            <p className="mt-0.5 truncate text-sm font-medium text-primary">{token.name}</p>
          </div>
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
      </div>

      {/* Pre-mounted, absolutely-positioned panel. Absolute → no layout impact;
          the rows below make room by translating. Fades with opacity (compositor)
          and never paints while closed.
          `inert` while closed is load-bearing: the panel stays in the DOM, so its
          explorer links and Manage link would otherwise stay tabbable and land
          keyboard users on invisible controls (opacity/pointer-events suppress
          neither). inert removes the subtree from sequential focus, hit testing,
          and the accessibility tree in one go. */}
      <div
        ref={panelRef}
        inert={!open}
        className="absolute inset-x-0 overflow-hidden rounded-2xl border border-border-default bg-surface-raised"
        style={{
          top: `calc(100% + ${ROW_GAP_PX}px)`,
          opacity: open ? 1 : 0,
          transition: `opacity ${ANIM_MS}ms ease-out`,
          pointerEvents: open ? "auto" : "none",
        }}
      >
        <div className="px-5 py-5">
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
      </div>
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
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set());
  const [heights, setHeights] = useState<Record<string, number>>({});

  const handleHeight = useCallback((id: string, height: number) => {
    setHeights((prev) => (prev[id] === height ? prev : { ...prev, [id]: height }));
  }, []);

  const toggle = useCallback((id: string) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // Each row is pushed down by the total height of every open panel above it.
  let running = 0;
  const rows = tokens.map((token) => {
    const open = openIds.has(token.id);
    const offset = running;
    if (open) {
      running += (heights[token.id] ?? 0) + ROW_GAP_PX;
    }
    return { token, open, offset };
  });
  const totalOffset = running;

  return (
    // Panels are absolute and rows/button move by transform, so opening a row
    // adds no layout height. Inside the issuance workspace's fixed-height scroll
    // region that means the displaced content (lower rows + Create Draft) would
    // slide past the scrollable extent and become unreachable. Reserve that space
    // with padding-bottom, transitioned in lockstep with the row transforms so
    // scrollHeight grows/shrinks smoothly alongside the motion.
    <div
      className="relative flex flex-col gap-2.5"
      style={{
        paddingBottom: totalOffset,
        transition: `padding ${ANIM_MS}ms ease-out`,
      }}
    >
      {rows.map(({ token, open, offset }) => (
        <IssuanceTokenListRow
          key={token.id}
          token={token}
          open={open}
          offset={offset}
          onToggle={() => toggle(token.id)}
          onHeight={handleHeight}
        />
      ))}
      <button
        type="button"
        onClick={onCreate}
        data-testid="token-add-row"
        className="flex items-center justify-center gap-2 rounded-2xl border border-dashed border-border-strong bg-surface-raised py-3.5 text-sm font-medium text-tertiary transition-colors hover:border-primary/40 hover:text-secondary"
        style={{
          transform: `translateY(${totalOffset}px)`,
          transition: `transform ${ANIM_MS}ms ease-out`,
          willChange: "transform",
        }}
      >
        <Plus className="h-4 w-4" />
        {t("DashboardIssuance.workspace.createDraft")}
      </button>
    </div>
  );
}
