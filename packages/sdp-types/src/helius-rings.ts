export const HELIUS_RINGS_OPERATION_STATUSES = [
  "draft",
  "preparing",
  // Retired: nothing enters this state any more (ADR 0006). It stays in the list because the
  // database CHECK constraints still allow it; dropping it needs a migration (see the table-drop change).
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
