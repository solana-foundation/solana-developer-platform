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
  SquarePen,
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
  PermissionControlStatus,
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
    return { className: "bg-success-bg text-success", showCheck: true };
  }
  if (normalized === FROZEN_STATUS_VALUE) {
    return { className: "bg-warning-bg text-warning", showCheck: false };
  }
  // .badge-gray — neutral fallback for all non-status values.
  return { className: "bg-fill text-secondary", showCheck: false };
}

// Custody-control badge on each authority row: green when the authority is held
// by an SDP custody wallet, amber when it's an external address SDP can't sign
// for. Hidden while unknown (wallets loading) or when no authority is set.
function ControlStatusBadge({ status }: { status?: PermissionControlStatus }) {
  const t = useTranslations();
  if (status !== "sdp" && status !== "external") {
    return null;
  }
  const isSdp = status === "sdp";
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        isSdp ? "bg-success-bg text-success" : "bg-warning-bg text-warning"
      }`}
    >
      {isSdp
        ? t("DashboardIssuance.permissions.managedBadge")
        : t("DashboardIssuance.permissions.externalBadge")}
    </span>
  );
}

function IconTile({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-border-subtle bg-fill-subtle text-secondary min-[450px]:flex">
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
        <p className="text-[15px] font-medium text-primary">{row.title}</p>
        <p className="text-[13px] text-tertiary">{row.helper}</p>
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
        <h3 className="text-[36px] leading-[40px] font-medium tracking-[-0.3px] text-primary">
          {mode === "permissions"
            ? t("DashboardIssuance.management.permissions")
            : t("DashboardIssuance.management.extensions")}
        </h3>
      ) : null}

      {mode === "permissions" ? (
        <div className="overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
          {permissionRows.map((row) => {
            const hasControlStatus =
              row.controlStatus === "sdp" || row.controlStatus === "external";
            return (
              <div
                key={row.id}
                data-testid={`permission-row-${row.id}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-3 border-b border-border-subtle px-4 py-3.5 last:border-b-0"
              >
                <IconTile icon={PERMISSION_ROW_ICONS[row.id]} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[15px] font-medium text-primary">{row.title}</p>
                    {/* Inline beside the title on desktop; on mobile the row is too
                      narrow, so it drops below the helper text instead. */}
                    {hasControlStatus ? (
                      <span className="hidden sm:inline-flex">
                        <ControlStatusBadge status={row.controlStatus} />
                      </span>
                    ) : null}
                  </div>
                  <p className="text-[13px] text-tertiary">{row.helper}</p>
                  {hasControlStatus ? (
                    <div className="mt-2 sm:hidden">
                      <ControlStatusBadge status={row.controlStatus} />
                    </div>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onCopy(row.value)}
                    className="inline-flex items-center gap-1 rounded-full border border-border-default bg-fill-subtle px-3 py-1 text-xs text-secondary"
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
                      iconLeft={<SquarePen />}
                      onClick={() => onEditAuthority(row)}
                      disabled={!canEditAuthorities || Boolean(row.editDisabledReason)}
                    >
                      {t("DashboardIssuance.management.edit")}
                    </Button>
                  </TokenDisabledActionTooltip>
                </div>
              </div>
            );
          })}
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
                  "overflow-hidden border-x border-border-default bg-surface-raised",
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
                      "flex items-center gap-3 border-b border-border-subtle px-4 py-3.5",
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
