"use client";

import { KeyRound, Puzzle } from "lucide-react";
import { TokenSettingsSection } from "../../token-settings-section";
import type { TokenOperations } from "../use-token-operations";

export function PermissionsTab({
  ops,
  canManageTokenAdmin,
}: {
  ops: TokenOperations;
  canManageTokenAdmin: boolean;
}) {
  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <SectionHeading
          icon={KeyRound}
          title="Authorities"
          description="On-chain keys that control minting, freezing, and metadata for this token."
        />
        <TokenSettingsSection
          mode="permissions"
          permissionRows={ops.permissionRows}
          extensionRows={ops.extensionRows}
          showTitle={false}
          canEditAuthorities={!ops.canDeployToken && canManageTokenAdmin}
          onCopy={ops.handleCopy}
          onEditAuthority={ops.handleAuthorityModalOpen}
        />
      </div>
      <div className="space-y-3 pt-2">
        <SectionHeading
          icon={Puzzle}
          title="Token-2022 extensions"
          description="Configured at creation and read-only after deploy."
        />
        <TokenSettingsSection
          mode="extensions"
          permissionRows={ops.permissionRows}
          extensionRows={ops.extensionRows}
          showTitle={false}
          canEditAuthorities={false}
          onCopy={ops.handleCopy}
          onEditAuthority={ops.handleAuthorityModalOpen}
        />
      </div>
    </div>
  );
}

function SectionHeading({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[rgba(28,28,29,0.05)] text-[#1c1c1d]">
        <Icon className="h-4.5 w-4.5" />
      </span>
      <div>
        <p className="text-base font-medium text-[#1c1c1d]">{title}</p>
        <p className="mt-0.5 text-sm text-[rgba(28,28,29,0.58)]">{description}</p>
      </div>
    </div>
  );
}
