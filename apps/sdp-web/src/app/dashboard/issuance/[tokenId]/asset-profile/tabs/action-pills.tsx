"use client";

import { Flame, HandCoins, type LucideIcon, Pause, ShieldCheck, Snowflake } from "lucide-react";
import { TokenDisabledActionTooltip } from "../../token-disabled-action-tooltip";
import type { AdminAction } from "../../token-management-workspace.types";

// Monochrome icons keep the selector scannable (SDP reserves colour for status).
const ACTION_ICONS: Partial<Record<AdminAction, LucideIcon>> = {
  allowlist: ShieldCheck,
  seize: HandCoins,
  "force-burn": Flame,
  freeze: Snowflake,
  pause: Pause,
};

// Underline tab bar: equal-width flex-1 tabs over a shared bottom border, with
// overflow-x-auto (scrollbar hidden) as a fallback when a locale can't fit. The
// underline lives inside the button box so the implicit overflow-y can't clip it.
export function ActionPills({
  actions,
  activeAction,
  disabledReasons,
  onSelectAction,
}: {
  actions: Array<{ id: AdminAction; label: string }>;
  activeAction: AdminAction | null;
  disabledReasons?: Partial<Record<AdminAction, string | null>>;
  onSelectAction: (action: AdminAction) => void;
}) {
  return (
    <div className="flex items-stretch overflow-x-auto border-b border-border-default [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {actions.map((action) => {
        const Icon = ACTION_ICONS[action.id];
        const isActive = activeAction === action.id;
        const isDisabled = Boolean(disabledReasons?.[action.id]);
        return (
          <div key={action.id} className="flex flex-1 justify-center">
            <TokenDisabledActionTooltip reason={disabledReasons?.[action.id]}>
              <button
                type="button"
                onClick={() => onSelectAction(action.id)}
                disabled={isDisabled}
                aria-pressed={isActive}
                className={[
                  "inline-flex w-full items-center justify-center gap-2 whitespace-nowrap border-b-2 px-1.5 pt-1 pb-3 text-sm transition-colors",
                  isActive
                    ? "border-primary font-semibold text-primary"
                    : "border-transparent font-medium text-tertiary hover:text-primary",
                  isDisabled ? "pointer-events-none opacity-40" : "",
                ].join(" ")}
              >
                {Icon ? <Icon className="h-4 w-4 shrink-0" /> : null}
                {action.label}
              </button>
            </TokenDisabledActionTooltip>
          </div>
        );
      })}
    </div>
  );
}
