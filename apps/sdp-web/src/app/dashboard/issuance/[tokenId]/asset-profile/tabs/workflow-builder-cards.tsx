"use client";

import { Select as BaseSelect } from "@base-ui/react/select";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  BadgeCheck,
  Bell,
  Check,
  ChevronDown,
  Coins,
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
} from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { cn } from "@/lib/utils";

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

// Status pills elsewhere in the dashboard are fully round; the shared Badge hard-codes
// `!rounded-sm`, so the workflow surfaces opt back into the project's pill shape. Applied
// here rather than in badge.tsx, which has call sites across every dashboard section.
export const WORKFLOW_PILL_CLASS = "!rounded-full";

// ── Card select (a dropdown whose options ARE the cards) ─────────────────────────────

// A status tone, kept to the four the workflow tiers need so the marker can map it to
// both a dot colour and a tinted tooltip without a 7-key table.
export type CardOptionTone = "default" | "success" | "warning" | "danger";

export interface CardSelectOption {
  value: string;
  icon: LucideIcon;
  label: string;
  description?: string | null;
  // The tier, as text + tone rather than a ready-made pill: it renders as a marker on
  // the icon tile with the text on its tooltip, which a caller-built node can't do.
  badgeText?: string;
  badgeTone?: CardOptionTone;
  note?: string;
  disabled?: boolean;
  // Optional heading this option groups under (e.g. a tier). Consecutive options that
  // share a group render under one heading; order is preserved.
  group?: string;
}

// The same tokens the badges use. A marker often sits on the row as an Enabled/guard pill,
// and the base status hues (`#00a066`…) are a visibly different green from the badge's
// `--green-tx`, so parity with the pills wins over a brighter dot.
// The `-mark` tokens: each status's border hue at full opacity. `-tx` is darkened for
// text contrast on light surfaces (amber lands on brown) and `-brd` is that hue at 20%,
// which is too faint for a mark this small to carry status on its own.
const TONE_DOT_CLASS: Record<CardOptionTone, string> = {
  default: "bg-fill-strong",
  success: "bg-success-mark",
  warning: "bg-warning-mark",
  danger: "bg-error-mark",
};

// Split in two because the tint is the tooltip's problem: in light mode every `*-bg`
// token is an 8%-alpha wash, so a bubble painted only in it let the row borders behind it
// show straight through. The bubble takes an opaque surface and the tint rides on top.
const TONE_TIP_BORDER_CLASS: Record<CardOptionTone, string> = {
  default: "border-border-strong",
  success: "border-success-border",
  warning: "border-warning-border",
  danger: "border-error-border",
};

const TONE_TIP_FILL_CLASS: Record<CardOptionTone, string> = {
  default: "bg-fill text-primary",
  success: "bg-success-bg text-success",
  warning: "bg-warning-bg text-warning",
  danger: "bg-error-bg text-error",
};

// The tier marker: a tone dot on the icon tile's corner, so stating the tier costs the
// text column nothing (the label ellipsised when a pill shared its line). Base UI's
// tooltip directly rather than the shared one — the shared wrapper styles only the text
// inside a fixed bubble, and the colored variant needs the bubble itself.
export function ToneMarker({
  label,
  tone,
  className,
}: {
  label: string;
  tone: CardOptionTone;
  className?: string;
}) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger
        // A span, not the default button: these markers sit inside a select option and
        // inside the select's own trigger button, where nested buttons are invalid.
        render={
          // No cut-out ring behind the dot: in light mode the surface token it would be
          // drawn in is near-white, which read as a hole punched in the icon tile.
          <span
            role="img"
            aria-label={label}
            className={cn(
              "absolute -top-0.5 -right-0.5 size-2.5 rounded-full",
              TONE_DOT_CLASS[tone],
              className
            )}
          />
        }
      />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner className="z-[60]" side="top" sideOffset={6}>
          {/* Tinted to the marker's own tone: the bubble is what connects the dot's
              colour to the words, so a neutral bubble would leave the dot undecodable. */}
          <BaseTooltip.Popup
            className={cn(
              "overflow-hidden rounded-lg border bg-surface-raised text-xs font-medium shadow-lg",
              TONE_TIP_BORDER_CLASS[tone]
            )}
          >
            <span className={cn("block px-2 py-1", TONE_TIP_FILL_CLASS[tone])}>{label}</span>
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}

// The label/description stack inside one option card. The tier is not in here at all: the
// marker on the icon tile and the group heading carry it, which is what lets the action
// name have the full width of the column.
function OptionBody({ option }: { option: CardSelectOption }) {
  return (
    <span className="min-w-0 flex-1 space-y-0.5">
      <BaseSelect.ItemText className="block text-sm font-medium text-primary">
        {option.label}
      </BaseSelect.ItemText>
      {option.description ? (
        <span className="block text-xs leading-4 text-tertiary">{option.description}</span>
      ) : null}
      {option.note ? <span className="block text-xs text-secondary">{option.note}</span> : null}
      {/* A group heading is not announced as part of the option and a tooltip is
          hover-only, so the tier still needs to be in the accessible name. */}
      {option.badgeText ? <span className="sr-only">{option.badgeText}</span> : null}
    </span>
  );
}

// A compact select trigger (icon + label) that opens a popover of rich cards. Built on
// the same Base UI primitive as the shared Select, so keyboard/focus/positioning are
// free — but the option content is a full card (icon, description, badge), not plain text.
export function CardSelect({
  value,
  onValueChange,
  placeholder,
  ariaLabel,
  disabled,
  options,
}: {
  value: string | null;
  onValueChange: (value: string | null) => void;
  placeholder: string;
  ariaLabel: string;
  disabled?: boolean;
  options: CardSelectOption[];
}) {
  // The trigger renders the selected option's label via this value→label map.
  const labelMap = useMemo(() => {
    const map: Record<string, ReactNode> = {};
    for (const option of options) {
      map[option.value] = option.label;
    }
    return map;
  }, [options]);

  const selected = options.find((option) => option.value === value) ?? null;
  const SelectedIcon = selected?.icon;

  // Bucket options by group, preserving first-seen order.
  const groups = useMemo(() => {
    const order: string[] = [];
    const byGroup = new Map<string, CardSelectOption[]>();
    for (const option of options) {
      const key = option.group ?? "";
      const bucket = byGroup.get(key);
      if (bucket) {
        bucket.push(option);
      } else {
        byGroup.set(key, [option]);
        order.push(key);
      }
    }
    return order.map((key) => ({ key, items: byGroup.get(key) ?? [] }));
  }, [options]);

  return (
    <BaseSelect.Root
      items={labelMap}
      value={value == null || value === "" ? null : value}
      onValueChange={(next) => onValueChange(next)}
      disabled={disabled}
    >
      <BaseSelect.Trigger
        aria-label={ariaLabel}
        className={cn(
          // Fixed height reserves the icon + label + description layout so the empty
          // placeholder trigger is the same height as a selected one (WHEN/THEN align).
          "group/cardselect relative flex min-h-[3.25rem] w-full cursor-pointer items-center gap-2.5 rounded-[var(--input-radius-lg)] px-3 py-1.5 text-left",
          disabled && "pointer-events-none opacity-40"
        )}
      >
        <span className="pointer-events-none absolute inset-0 rounded-[inherit] bg-fill-subtle group-[[data-popup-open]]/cardselect:shadow-[0_0_0_2px_var(--input-focus-ring)]" />
        {selected ? (
          // The trigger mirrors the chosen option's card content (icon + marker + label +
          // info line) so the selection reads the same closed as it does in the list.
          <>
            {SelectedIcon ? (
              <span className="relative flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-raised text-secondary">
                <SelectedIcon className="size-[18px]" />
                {selected.badgeText ? (
                  <ToneMarker label={selected.badgeText} tone={selected.badgeTone ?? "default"} />
                ) : null}
              </span>
            ) : null}
            <span className="relative min-w-0 flex-1 space-y-0.5">
              <span className="block truncate text-sm font-medium text-primary">
                {selected.label}
              </span>
              {selected.description ? (
                <span className="block truncate text-xs text-tertiary">{selected.description}</span>
              ) : null}
            </span>
          </>
        ) : (
          <span className="relative min-w-0 flex-1 truncate text-sm text-[var(--input-placeholder-color)]">
            {placeholder}
          </span>
        )}
        <BaseSelect.Icon className="relative inline-flex shrink-0 items-center justify-center self-center text-secondary transition-transform duration-150 group-[[data-popup-open]]/cardselect:rotate-180">
          <ChevronDown className="size-4" />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner className="z-50" sideOffset={4} alignItemWithTrigger={false}>
          <BaseSelect.Popup className="max-h-[var(--available-height)] w-[var(--anchor-width)] min-w-[15rem] space-y-2 overflow-y-auto rounded-xl border border-border-default bg-surface-raised p-1.5 shadow-lg outline-none">
            {groups.flatMap((group) => [
              group.key ? (
                <div
                  key={`heading-${group.key}`}
                  className="flex items-center gap-1.5 px-2 pt-1 text-[11px] font-semibold uppercase tracking-wide text-tertiary"
                >
                  {/* The heading is where the tier is spelled out, so it takes the same
                      tone dot the options carry — the marker's colour is only decodable
                      if something states it in words nearby. */}
                  <span
                    aria-hidden
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      TONE_DOT_CLASS[group.items[0]?.badgeTone ?? "default"]
                    )}
                  />
                  {group.key}
                </div>
              ) : null,
              ...group.items.map((option) => {
                const Icon = option.icon;
                // Driven off the controlled value, not a data-attribute: the selected
                // option gets the same accent treatment as the grid cards (primary border
                // + filled check), so selection reads identically in both surfaces.
                const isSelected = option.value === value;
                return (
                  <BaseSelect.Item
                    key={option.value}
                    value={option.value}
                    disabled={option.disabled}
                    className={cn(
                      // Centred, not top-aligned: the icon tile and the check ring read as
                      // floating when a two- or three-line description sits between them.
                      "flex cursor-pointer items-center gap-3 rounded-lg border px-2.5 py-2 outline-none transition-colors",
                      isSelected
                        ? "border-primary bg-fill-subtle/50"
                        : "border-transparent data-[highlighted]:border-border-default data-[highlighted]:bg-fill-subtle",
                      "data-[disabled]:pointer-events-none data-[disabled]:opacity-40"
                    )}
                  >
                    <span
                      className={cn(
                        "relative flex size-9 shrink-0 items-center justify-center rounded-lg bg-fill-subtle",
                        isSelected ? "text-primary" : "text-tertiary"
                      )}
                    >
                      <Icon className="size-[18px]" />
                      {option.badgeText ? (
                        <ToneMarker label={option.badgeText} tone={option.badgeTone ?? "default"} />
                      ) : null}
                    </span>
                    <OptionBody option={option} />
                    <span
                      className={cn(
                        "flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
                        isSelected
                          ? "border-primary bg-primary text-on-primary"
                          : "border-border-default text-transparent"
                      )}
                      aria-hidden
                    >
                      <Check className="size-3" strokeWidth={3} />
                    </span>
                  </BaseSelect.Item>
                );
              }),
            ])}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}

// Circular arrow badge — the connector between builder stages. Bordered + raised so it
// stands out against the cards (flat: no shadow, colour reserved for status).
export function ConnectorBadge({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="flex size-9 items-center justify-center rounded-full border border-border-strong bg-surface-raised text-secondary">
      <Icon className="size-[18px]" />
    </span>
  );
}
