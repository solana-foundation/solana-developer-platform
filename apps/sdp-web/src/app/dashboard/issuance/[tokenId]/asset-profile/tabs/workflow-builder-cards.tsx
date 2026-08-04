"use client";

import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUpFromLine,
  BadgeCheck,
  Bell,
  Coins,
  CornerDownRight,
  FileText,
  Flame,
  HandCoins,
  type LucideIcon,
  Pause,
  Play,
  Snowflake,
  Sun,
  TriangleAlert,
  UserMinus,
  UserPlus,
  UserX,
  Webhook,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { CatalogActionView, CatalogTriggerView, ExecutionTier } from "../workflows.data";

// Icons reserve a scannable identity for each trigger/action without leaning on colour
// (SDP keeps colour for status). Missing keys fall back to a neutral glyph, so a
// catalog entry the client doesn't know still renders a valid card.
export const TRIGGER_ICONS: Record<string, LucideIcon> = {
  kyc_approved: BadgeCheck,
  kyc_rejected: UserX,
  onramp_settled: ArrowDownToLine,
  offramp_settled: ArrowUpFromLine,
  recurring_payment_failed: TriangleAlert,
  token_operation_completed: Coins,
};

export const ACTION_ICONS: Record<string, LucideIcon> = {
  allowlist_add: UserPlus,
  allowlist_remove: UserMinus,
  send_webhook: Webhook,
  notify: Bell,
  record: FileText,
  pause: Pause,
  unpause: Play,
  freeze: Snowflake,
  unfreeze: Sun,
  seize: HandCoins,
  force_burn: Flame,
  burn: Flame,
  mint: Coins,
};

const TIER_VARIANT: Record<ExecutionTier, "success" | "warning" | "danger"> = {
  automated: "success",
  sensitive: "warning",
  requires_approval: "danger",
};

// Tier headings borrow the status palette (risk is a status): green = safe/reversible,
// amber = disruptive, red = irreversible. The only colour on the selection surface.
const TIER_HEADING_TONE: Record<ExecutionTier, string> = {
  automated: "text-success",
  sensitive: "text-warning",
  requires_approval: "text-error",
};

const TIER_ORDER: ExecutionTier[] = ["automated", "sensitive", "requires_approval"];

// Loosely-typed localizers passed down from the tab (closures over `t`) so this file
// stays decoupled from the tab's internal helper types.
type LabelFn = (kind: "trigger" | "action", type: string) => string;
type DescribeFn = (kind: "trigger" | "action", type: string | null | undefined) => string | null;
type WfFn = (k: string, values?: Record<string, string | number>) => string;

// ── Selectable icon card ─────────────────────────────────────────────────────────────

export function SelectableCard({
  icon: Icon,
  heading,
  description,
  badge,
  note,
  selected,
  disabled,
  onSelect,
  ariaLabel,
}: {
  icon: LucideIcon;
  // `heading`, not `title`: a `title` JSX attribute is treated as user-facing copy by
  // the i18n audit, which would then flag the i18n *keys* passed through it.
  heading: string;
  description?: string | null;
  badge?: ReactNode;
  note?: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  ariaLabel?: string;
}) {
  // A selected card keeps its selected skin even when locked (editing) — the lock just
  // removes the pointer, it must not read as "muted/unavailable".
  const muted = disabled && !selected;
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      aria-label={ariaLabel}
      className={cn(
        "group flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-default focus-visible:ring-offset-1",
        muted
          ? "cursor-not-allowed border-border-subtle bg-fill-subtle/40 opacity-60"
          : selected
            ? "border-primary bg-fill-subtle"
            : "border-border-default bg-surface-raised hover:bg-fill-subtle"
      )}
    >
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors",
          selected ? "bg-fill-strong text-primary" : "bg-fill-subtle text-secondary",
          muted ? "" : "group-hover:text-primary"
        )}
        aria-hidden
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium text-primary">{heading}</span>
          {badge}
        </span>
        {description ? (
          <span className="line-clamp-2 block text-xs leading-4 text-tertiary">{description}</span>
        ) : null}
        {note ? <span className="block text-xs text-secondary">{note}</span> : null}
      </span>
    </button>
  );
}

// ── Trigger selection grid ───────────────────────────────────────────────────────────

export function TriggerCardGrid({
  triggers,
  value,
  locked,
  onChange,
  label,
  describe,
  columns = 3,
}: {
  triggers: CatalogTriggerView[];
  value: string | null;
  // Editing a rule locks its trigger; the chosen card stays lit, the rest go inert.
  locked?: boolean;
  onChange: (type: string) => void;
  label: LabelFn;
  describe: DescribeFn;
  columns?: 1 | 2 | 3;
}) {
  return (
    <div className={cn("grid gap-2", GRID_COLS[columns])}>
      {triggers.map((tr) => {
        const Icon = TRIGGER_ICONS[tr.type] ?? Zap;
        return (
          <SelectableCard
            key={tr.type}
            icon={Icon}
            heading={label("trigger", tr.type)}
            description={describe("trigger", tr.type)}
            selected={value === tr.type}
            disabled={locked}
            onSelect={() => onChange(tr.type)}
          />
        );
      })}
    </div>
  );
}

// ── Action selection grid (grouped by tier) ──────────────────────────────────────────

export function ActionCardGrid({
  actions,
  value,
  locked,
  canUseAction,
  onChange,
  label,
  describe,
  wf,
  columns = 3,
}: {
  actions: CatalogActionView[];
  value: string | null;
  locked?: boolean;
  canUseAction: (type: string) => boolean;
  onChange: (type: string) => void;
  label: LabelFn;
  describe: DescribeFn;
  wf: WfFn;
  columns?: 1 | 2 | 3;
}) {
  // View models are resolved OUTSIDE the JSX tree on purpose: the i18n audit scans
  // string literals inside JSX children/attributes, and would flag the i18n keys these
  // wrapper calls (`wf`/`label`/`describe`) pass. Resolving here keeps the JSX literal-free.
  const groups = TIER_ORDER.map((tier) => {
    const items = actions.filter((a) => a.action.execution === tier);
    return {
      tier,
      heading: wf(`tierLabels.${tier}`),
      cards: items.map((a) => {
        const permitted = canUseAction(a.type);
        const unsupported = !a.support.ok;
        return {
          type: a.type,
          icon: ACTION_ICONS[a.type] ?? Play,
          heading: label("action", a.type),
          // `blurb`, not `description`: an object property named `description` is scanned
          // as user-facing copy by the i18n audit (it would flag the key inside).
          blurb: describe("action", a.type),
          tierBadge: wf(`tierLabels.${a.action.execution}`),
          tierVariant: TIER_VARIANT[a.action.execution],
          note: unsupported
            ? stripSuffix(wf("unavailableSuffix"))
            : permitted
              ? undefined
              : stripSuffix(wf("adminOnlySuffix")),
          selected: value === a.type,
          disabled: locked || unsupported || !permitted,
        };
      }),
    };
  }).filter((group) => group.cards.length > 0);

  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <div key={group.tier} className="space-y-2">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "text-[11px] font-semibold uppercase tracking-wide",
                TIER_HEADING_TONE[group.tier]
              )}
            >
              {group.heading}
            </span>
            <span className="h-px flex-1 bg-border-subtle" aria-hidden />
          </div>
          <div className={cn("grid gap-2", GRID_COLS[columns])}>
            {group.cards.map((card) => (
              <SelectableCard
                key={card.type}
                icon={card.icon}
                heading={card.heading}
                description={card.blurb}
                badge={<Badge variant={card.tierVariant}>{card.tierBadge}</Badge>}
                note={card.note}
                selected={card.selected}
                disabled={card.disabled}
                onSelect={() => onChange(card.type)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Flow connector (the "arrows" between stages) ─────────────────────────────────────

export function FlowConnector({
  orientation = "vertical",
  label,
}: {
  orientation?: "vertical" | "horizontal";
  // Optional inline caption (e.g. an "only if…" note riding the arrow).
  label?: string;
}) {
  if (orientation === "horizontal") {
    return (
      <div className="flex shrink-0 items-center gap-2 self-center text-tertiary" aria-hidden>
        <span className="h-px w-4 bg-border-default sm:w-6" />
        <ArrowDown className="size-4 rotate-[-90deg]" />
        {label ? <span className="text-xs text-secondary">{label}</span> : null}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 py-1 pl-4 text-tertiary" aria-hidden>
      <CornerDownRight className="size-4" />
      {label ? (
        <span className="text-xs text-secondary">{label}</span>
      ) : (
        <span className="h-px flex-1 bg-transparent" />
      )}
    </div>
  );
}

const GRID_COLS: Record<1 | 2 | 3, string> = {
  1: "grid-cols-1",
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3",
};

// "  — unavailable" → "unavailable": the catalog suffix carries a separator for inline
// use; on a card it stands alone.
function stripSuffix(value: string): string {
  return value.replace(/^[\s—·-]+/, "").trim();
}
