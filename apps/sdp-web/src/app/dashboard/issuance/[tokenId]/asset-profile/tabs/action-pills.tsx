"use client";

import { TokenDisabledActionTooltip } from "../../token-disabled-action-tooltip";
import type { AdminAction } from "../../token-management-workspace.types";

// Pill selector for admin action forms — same pattern as the legacy
// workspace's ActionSelector.
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
    <div className="flex flex-wrap gap-2">
      {actions.map((action) => (
        <TokenDisabledActionTooltip key={action.id} reason={disabledReasons?.[action.id]}>
          <button
            type="button"
            onClick={() => onSelectAction(action.id)}
            disabled={Boolean(disabledReasons?.[action.id])}
            className={[
              "inline-flex h-10 items-center rounded-[12px] px-4 text-sm font-medium transition-colors",
              activeAction === action.id
                ? "bg-primary text-on-primary"
                : "bg-fill text-primary hover:bg-fill-strong disabled:pointer-events-none disabled:opacity-50",
            ].join(" ")}
          >
            {action.label}
          </button>
        </TokenDisabledActionTooltip>
      ))}
    </div>
  );
}
