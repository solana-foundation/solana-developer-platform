"use client";

import {
  Ban,
  Check,
  CircleDollarSign,
  Coins,
  Copy,
  FileText,
  KeyRound,
  LayoutTemplate,
  ListChecks,
  Lock,
  type LucideIcon,
  Percent,
  Puzzle,
  Scaling,
  Snowflake,
  UserCog,
  Webhook,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TokenDisabledActionTooltip } from "./token-disabled-action-tooltip";
import type { ExtensionRow, PermissionRow } from "./token-management-workspace.types";
import { formatValue } from "./token-management-workspace.utils";

interface TokenSettingsSectionProps {
  mode: "permissions" | "extensions";
  permissionRows: PermissionRow[];
  extensionRows: ExtensionRow[];
  showTitle?: boolean;
  canEditAuthorities: boolean;
  onCopy: (value: string | null) => void;
  onEditAuthority: (row: PermissionRow) => void;
}

// Maps each authority / extension row to a line icon that echoes the
// Token-2022 feature it represents. Keyed by the stable row `id`.
const ROW_ICONS: Record<string, LucideIcon> = {
  // Authorities
  "mint-authority": Coins,
  "freeze-authority": Snowflake,
  "metadata-authority": FileText,
  "permanent-delegate": UserCog,
  // Extensions
  template: LayoutTemplate,
  "control-list": ListChecks,
  mintable: Coins,
  freezable: Snowflake,
  "default-account-state": Lock,
  "transfer-fee": CircleDollarSign,
  "scaled-ui": Scaling,
  "transfer-hook": Webhook,
  "interest-bearing": Percent,
  "non-transferable": Ban,
};

function iconForRow(id: string, fallback: LucideIcon): LucideIcon {
  return ROW_ICONS[id] ?? fallback;
}

// Status is the only thing that carries color. Values below are the exact SDP
// design-system semantic tokens (sdp-design-system.css): enabled/configured =
// .badge-green (--green-bg/--green-tx), frozen = .badge-amber
// (--amber-bg/--amber-tx), everything else = .badge-gray (--t8/--emph-m).
function extensionBadge(value: string): { className: string; showCheck: boolean } {
  const normalized = value.trim().toLowerCase();
  if (normalized === "enabled" || normalized === "configured") {
    return { className: "bg-[rgba(0,160,102,0.08)] text-[#00a066]", showCheck: true };
  }
  if (normalized === "frozen") {
    return { className: "bg-[rgba(234,179,8,0.08)] text-[#92400e]", showCheck: false };
  }
  return { className: "bg-[rgba(28,28,29,0.08)] text-[rgba(28,28,29,0.72)]", showCheck: false };
}

function IconTile({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-[rgba(28,28,29,0.08)] bg-[rgba(28,28,29,0.04)] text-[rgba(28,28,29,0.7)] min-[450px]:flex">
      <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
    </span>
  );
}

function ExtensionItem({ row }: { row: ExtensionRow }) {
  const badge = extensionBadge(row.value);
  return (
    <>
      <IconTile icon={iconForRow(row.id, Puzzle)} />
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-medium text-[#1c1c1d]">{row.title}</p>
        <p className="text-[13px] text-[rgba(28,28,29,0.6)]">{row.helper}</p>
      </div>
      <span
        className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${badge.className}`}
      >
        {badge.showCheck ? <Check className="h-3 w-3" /> : null}
        {row.value}
      </span>
    </>
  );
}

export function TokenSettingsSection({
  mode,
  permissionRows,
  extensionRows,
  showTitle = true,
  canEditAuthorities,
  onCopy,
  onEditAuthority,
}: TokenSettingsSectionProps) {
  // Extensions render as two vertical lists side by side: split the rows into a
  // left and right column so each is its own joined container.
  const extensionSplit = Math.ceil(extensionRows.length / 2);
  const extensionColumns = [
    { key: "extensions-col-1", rows: extensionRows.slice(0, extensionSplit) },
    { key: "extensions-col-2", rows: extensionRows.slice(extensionSplit) },
  ].filter((column) => column.rows.length > 0);

  return (
    <section className="space-y-3">
      {showTitle ? (
        <h3 className="text-[36px] leading-[40px] font-medium tracking-[-0.3px] text-[#1c1c1d]">
          {mode === "permissions" ? "Permissions" : "Extensions"}
        </h3>
      ) : null}

      {mode === "permissions" ? (
        <div className="overflow-hidden rounded-2xl border border-[rgba(28,28,29,0.12)] bg-white">
          {permissionRows.map((row) => (
            <div
              key={row.id}
              data-testid={`permission-row-${row.id}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-3 border-b border-[rgba(28,28,29,0.08)] px-4 py-3.5 last:border-b-0"
            >
              <IconTile icon={iconForRow(row.id, KeyRound)} />
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-medium text-[#1c1c1d]">{row.title}</p>
                <p className="text-[13px] text-[rgba(28,28,29,0.6)]">{row.helper}</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onCopy(row.value)}
                  className="inline-flex items-center gap-1 rounded-full border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.02)] px-3 py-1 text-xs text-[rgba(28,28,29,0.75)]"
                >
                  {formatValue(row.value)}
                  {row.value ? <Copy className="h-3 w-3" /> : null}
                </button>
                <TokenDisabledActionTooltip
                  reason={
                    !canEditAuthorities
                      ? "Token must be deployed before editing authorities."
                      : (row.editDisabledReason ?? null)
                  }
                >
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onEditAuthority(row)}
                    disabled={!canEditAuthorities || Boolean(row.editDisabledReason)}
                  >
                    Edit
                  </Button>
                </TokenDisabledActionTooltip>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 items-start gap-0 md:grid-cols-2 md:gap-3">
          {extensionColumns.map((column, columnIndex) => {
            const isFirstColumn = columnIndex === 0;
            const isLastColumn = columnIndex === extensionColumns.length - 1;
            return (
              <div
                key={column.key}
                className={cn(
                  "overflow-hidden border-x border-[rgba(28,28,29,0.12)] bg-white",
                  isFirstColumn && "rounded-t-2xl border-t",
                  isLastColumn && "rounded-b-2xl border-b",
                  "md:rounded-2xl md:border"
                )}
              >
                {column.rows.map((row) => (
                  <div
                    key={row.id}
                    data-testid={`extension-row-${row.id}`}
                    className={cn(
                      "flex items-center gap-3 border-b border-[rgba(28,28,29,0.08)] px-4 py-3.5",
                      // Non-last columns keep the divider under their final row so
                      // the stacked mobile list stays continuous; desktop drops it.
                      isLastColumn ? "last:border-b-0" : "md:last:border-b-0"
                    )}
                  >
                    <ExtensionItem row={row} />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
