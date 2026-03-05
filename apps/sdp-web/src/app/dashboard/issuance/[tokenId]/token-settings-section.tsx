"use client";

import { Button } from "@/components/ui/button";
import { Copy } from "lucide-react";
import type {
  AdminAction,
  ExtensionRow,
  PermissionRow,
  SettingsTab,
} from "./token-management-workspace.types";
import { formatValue } from "./token-management-workspace.utils";

interface TokenSettingsSectionProps {
  settingsTab: SettingsTab;
  permissionRows: PermissionRow[];
  extensionRows: ExtensionRow[];
  onSettingsTabChange: (tab: SettingsTab) => void;
  onCopy: (value: string | null) => void;
  onEditAction: (action: AdminAction) => void;
}

export function TokenSettingsSection({
  settingsTab,
  permissionRows,
  extensionRows,
  onSettingsTabChange,
  onCopy,
  onEditAction,
}: TokenSettingsSectionProps) {
  return (
    <section className="space-y-3">
      <h3 className="text-[36px] leading-[40px] font-medium tracking-[-0.3px] text-[#1c1c1d]">
        Settings
      </h3>
      <div className="border-b border-[rgba(28,28,29,0.12)]">
        <div className="flex gap-8">
          <button
            type="button"
            onClick={() => onSettingsTabChange("permissions")}
            className={[
              "relative pb-3 text-[16px] leading-[24px] font-medium",
              settingsTab === "permissions" ? "text-[#1c1c1d]" : "text-[rgba(28,28,29,0.58)]",
            ].join(" ")}
          >
            Permissions
            {settingsTab === "permissions" ? (
              <span className="absolute right-0 bottom-[-1px] left-0 h-[2px] bg-[#1c1c1d]" />
            ) : null}
          </button>
          <button
            type="button"
            onClick={() => onSettingsTabChange("extensions")}
            className={[
              "relative pb-3 text-[16px] leading-[24px] font-medium",
              settingsTab === "extensions" ? "text-[#1c1c1d]" : "text-[rgba(28,28,29,0.58)]",
            ].join(" ")}
          >
            Extensions
            {settingsTab === "extensions" ? (
              <span className="absolute right-0 bottom-[-1px] left-0 h-[2px] bg-[#1c1c1d]" />
            ) : null}
          </button>
        </div>
      </div>

      {settingsTab === "permissions" ? (
        <div className="overflow-hidden rounded-2xl border border-[rgba(28,28,29,0.12)] bg-white">
          {permissionRows.map((row) => (
            <div
              key={row.id}
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
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onEditAction(row.action)}
                >
                  Edit
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-[rgba(28,28,29,0.12)] bg-white">
          {extensionRows.map((row) => (
            <div
              key={row.id}
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
