"use client";

import type { DraftState } from "../../../create/issuance-draft-wizard.types";
import { PublicInfoPreview } from "../../../create/public-info-preview";

// The unsaved-changes state is surfaced by the floating save bar; no top banner
// here, so toggling a field never shifts the layout.
export function PublicInfoTab({
  draft,
  onToggleField,
  disabled,
}: {
  draft: DraftState;
  onToggleField: (path: string, enabled: boolean) => void;
  disabled?: boolean;
}) {
  return <PublicInfoPreview draft={draft} onToggleField={onToggleField} disabled={disabled} />;
}
