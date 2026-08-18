"use client";

import { Select as BaseSelect } from "@base-ui/react/select";
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

// ── Card select (a dropdown whose options ARE the cards) ─────────────────────────────

export interface CardSelectOption {
  value: string;
  icon: LucideIcon;
  label: string;
  description?: string | null;
  badge?: ReactNode;
  note?: string;
  disabled?: boolean;
  // Optional heading this option groups under (e.g. a tier). Consecutive options that
  // share a group render under one heading; order is preserved.
  group?: string;
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
          // The trigger mirrors the chosen option's card content (icon + label + badge +
          // info line) so the selection reads the same closed as it does in the list.
          <>
            {SelectedIcon ? (
              <span className="relative flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-raised text-secondary">
                <SelectedIcon className="size-[18px]" />
              </span>
            ) : null}
            <span className="relative min-w-0 flex-1 space-y-0.5">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-medium text-primary">{selected.label}</span>
                {selected.badge}
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
          <BaseSelect.Popup className="max-h-[var(--available-height)] w-[max(var(--anchor-width),20rem)] space-y-2 overflow-y-auto rounded-xl border border-border-default bg-surface-raised p-1.5 shadow-lg outline-none">
            {groups.flatMap((group) => [
              group.key ? (
                <div
                  key={`heading-${group.key}`}
                  className="px-2 pt-1 text-[11px] font-semibold uppercase tracking-wide text-tertiary"
                >
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
                      "flex cursor-pointer items-start gap-3 rounded-lg border px-2.5 py-2 outline-none transition-colors",
                      isSelected
                        ? "border-primary bg-fill-subtle/50"
                        : "border-transparent data-[highlighted]:border-border-default data-[highlighted]:bg-fill-subtle",
                      "data-[disabled]:pointer-events-none data-[disabled]:opacity-40"
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-9 shrink-0 items-center justify-center rounded-lg bg-fill-subtle",
                        isSelected ? "text-primary" : "text-tertiary"
                      )}
                    >
                      <Icon className="size-[18px]" />
                    </span>
                    <span className="min-w-0 flex-1 space-y-0.5">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <BaseSelect.ItemText className="text-sm font-medium text-primary">
                          {option.label}
                        </BaseSelect.ItemText>
                        {option.badge}
                      </span>
                      {option.description ? (
                        <span className="block text-xs leading-4 text-tertiary">
                          {option.description}
                        </span>
                      ) : null}
                      {option.note ? (
                        <span className="block text-xs text-secondary">{option.note}</span>
                      ) : null}
                    </span>
                    <span
                      className={cn(
                        "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
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
    <span className="flex size-7 items-center justify-center rounded-full border border-border-strong bg-surface-raised text-secondary">
      <Icon className="size-4" />
    </span>
  );
}
