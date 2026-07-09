"use client";

import type { DraftState } from "../../../create/issuance-draft-wizard.types";
import { PublicInfoPreview } from "../../../create/public-info-preview";

// The unsaved-changes state is surfaced by the floating save bar; no top banner
// here, so toggling a field never shifts the layout. Unlike the create wizard,
// a deployed token has an on-chain mint address, so the preview's explorer
// surface can show the real address + explorer link.
export function PublicInfoTab({
  draft,
  onToggleField,
  disabled,
  mintAddress,
  explorerHref,
}: {
  draft: DraftState;
  onToggleField: (path: string, enabled: boolean) => void;
  disabled?: boolean;
  mintAddress?: string | null;
  explorerHref?: string | null;
}) {
  return (
    <PublicInfoPreview
      draft={draft}
      onToggleField={onToggleField}
      disabled={disabled}
      mintAddress={mintAddress}
      explorerHref={explorerHref}
    />
  );
}
