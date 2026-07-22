/**
 * Per-asset audit history — the read-side shape of the existing `audit_logs`
 * write pipeline, scoped to a single issued token/asset for the management view.
 */

/** Who performed an audited action, derived from the stored actor ids. */
export type AssetAuditActorType = "user" | "api_key" | "system";

/**
 * A single audit event surfaced in an asset's activity feed. Mirrors an
 * `audit_logs` row with the actor resolved to a display label.
 */
export interface AssetAuditEvent {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  /** `system` covers automated/workflow actions with no human or API-key actor. */
  actorType: AssetAuditActorType;
  actorLabel: string;
  status: "success" | "failure";
  createdAt: string;
  metadata: Record<string, unknown> | null;
}

/**
 * Actions surfaced as filter options in the per-asset activity feed. A subset of
 * the full `AuditAction` union relevant to post-issuance asset management.
 */
export const ASSET_AUDIT_ACTIONS = [
  "deploy",
  "mint",
  "burn",
  "freeze",
  "unfreeze",
  "seize",
  "force_burn",
  "update_authority",
  "pause",
  "unpause",
  "create",
  "update",
  "revoke",
] as const;

export type AssetAuditAction = (typeof ASSET_AUDIT_ACTIONS)[number];
