"use client";

import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
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

export function TokenSettingsSection({
  mode,
  permissionRows,
  extensionRows,
  showTitle = true,
  canEditAuthorities,
  onCopy,
  onEditAuthority,
}: TokenSettingsSectionProps) {
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
              className="flex flex-wrap items-center justify-between gap-3 border-b border-[rgba(28,28,29,0.08)] px-4 py-3 last:border-b-0"
            >
              <div>
                <p className="text-[17px] font-medium text-[#1c1c1d]">{row.title}</p>
                <p className="text-sm text-[rgba(28,28,29,0.62)]">{row.helper}</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onCopy(row.value)}
                  className="inline-flex items-center gap-1 rounded-full border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.02)] px-3 py-1 text-xs font-mono text-[rgba(28,28,29,0.75)]"
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
        <div className="overflow-hidden rounded-2xl border border-[rgba(28,28,29,0.12)] bg-white">
          {extensionRows.map((row) => (
            <div
              key={row.id}
              data-testid={`extension-row-${row.id}`}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-[rgba(28,28,29,0.08)] px-4 py-3 last:border-b-0"
            >
              <div>
                <p className="text-[17px] font-medium text-[#1c1c1d]">{row.title}</p>
                <p className="text-sm text-[rgba(28,28,29,0.62)]">{row.helper}</p>
              </div>
              <span className="rounded-full border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.02)] px-3 py-1 text-sm text-[rgba(28,28,29,0.75)]">
                {row.value}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
