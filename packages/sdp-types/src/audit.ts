/**
 * Per-asset audit history — the read-side shape of the existing `audit_logs`
 * write pipeline, scoped to a single issued token/asset for the management view.
 */

/**
 * Who performed an audited action, derived from the stored actor ids. Surfaced
 * as the "type" filter options in the per-asset activity feed.
 */
export const ASSET_AUDIT_ACTOR_TYPES = ["user", "api_key", "system"] as const;

export type AssetAuditActorType = (typeof ASSET_AUDIT_ACTOR_TYPES)[number];

export function isAssetAuditActorType(value: string): value is AssetAuditActorType {
  return (ASSET_AUDIT_ACTOR_TYPES as readonly string[]).includes(value);
}

/** Outcome of an audited action; the "status" filter options in the feed. */
export const ASSET_AUDIT_STATUSES = ["success", "failure"] as const;

export type AssetAuditStatus = (typeof ASSET_AUDIT_STATUSES)[number];

export function isAssetAuditStatus(value: string): value is AssetAuditStatus {
  return (ASSET_AUDIT_STATUSES as readonly string[]).includes(value);
}

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
  status: AssetAuditStatus;
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
