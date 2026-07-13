"use client";

import {
  Ban,
  Check,
  CircleDollarSign,
  Coins,
  Copy,
  FileText,
  LayoutTemplate,
  ListChecks,
  Lock,
  type LucideIcon,
  Percent,
  Scaling,
  Snowflake,
  UserCog,
  Webhook,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { TokenDisabledActionTooltip } from "./token-disabled-action-tooltip";
import type {
  ExtensionRow,
  ExtensionRowId,
  PermissionRow,
  PermissionRowId,
} from "./token-management-workspace.types";
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
// Token-2022 feature it represents. Keyed by the row `id` unions, so these
// records are exhaustive: adding or renaming a row id in the workspace layer
// fails to compile here until the icon is supplied — no silent fallback.
const PERMISSION_ROW_ICONS: Record<PermissionRowId, LucideIcon> = {
  "mint-authority": Coins,
  "freeze-authority": Snowflake,
  "metadata-authority": FileText,
  "permanent-delegate": UserCog,
};

const EXTENSION_ROW_ICONS: Record<ExtensionRowId, LucideIcon> = {
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

// Status is the only thing that carries color, using the exact SDP design-system
// semantic tokens (sdp-design-system.css). Only the status values enumerated
// below are colored; every other value — numeric ("0.25%", "5%"), display
// labels, "Disabled", or any status the API adds later — is intentionally the
// neutral gray fallback. Add a value to the relevant set to give it color.
const POSITIVE_STATUS_VALUES = new Set(["enabled", "configured"]); // .badge-green
const FROZEN_STATUS_VALUE = "frozen"; // .badge-amber

function extensionBadge(value: string): { className: string; showCheck: boolean } {
  const normalized = value.trim().toLowerCase();
  if (POSITIVE_STATUS_VALUES.has(normalized)) {
    return { className: "bg-[rgba(0,160,102,0.08)] text-[#00a066]", showCheck: true };
  }
  if (normalized === FROZEN_STATUS_VALUE) {
    return { className: "bg-[rgba(234,179,8,0.08)] text-[#92400e]", showCheck: false };
  }
  // .badge-gray — neutral fallback for all non-status values.
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
      <IconTile icon={EXTENSION_ROW_ICONS[row.id]} />
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
  const t = useTranslations();
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
          {mode === "permissions"
            ? t("DashboardIssuance.management.permissions")
            : t("DashboardIssuance.management.extensions")}
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
              <IconTile icon={PERMISSION_ROW_ICONS[row.id]} />
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
                  {formatValue(row.value, t)}
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
                    {t("DashboardIssuance.management.edit")}
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
