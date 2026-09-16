export const HELIUS_RINGS_OPERATION_STATUSES = [
  "draft",
  "preparing",
  "approval_required",
  "proving",
  "ready_to_sign",
  "submitted",
  "indexing",
  "completed",
  "failed",
  "voided",
] as const;

export type HeliusRingsOperationStatus = (typeof HELIUS_RINGS_OPERATION_STATUSES)[number];

export const HELIUS_RINGS_OPERATION_TYPES = [
  "shield",
  "transfer_registered",
  "transfer_anonymous",
  "withdraw",
  "merge",
  "timelock_create",
  "timelock_settle",
  "zone_create",
  "ring_exit",
  "ring_entry",
] as const;

export type HeliusRingsOperationType = (typeof HELIUS_RINGS_OPERATION_TYPES)[number];
