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

/**
 * States nothing enters any more (ADR 0006). They stay in the list above only
 * because the database CHECK constraints still allow them, so a stored row can
 * still carry one. Dropping them needs a migration (see the table-drop change).
 */
export const HELIUS_RINGS_RETIRED_OPERATION_STATUSES = ["approval_required"] as const;

export type HeliusRingsRetiredOperationStatus =
  (typeof HELIUS_RINGS_RETIRED_OPERATION_STATUSES)[number];

export type HeliusRingsLiveOperationStatus = Exclude<
  HeliusRingsOperationStatus,
  HeliusRingsRetiredOperationStatus
>;

/** Every status an operation can still reach, in lifecycle order. */
export const HELIUS_RINGS_LIVE_OPERATION_STATUSES = HELIUS_RINGS_OPERATION_STATUSES.filter(
  (status): status is HeliusRingsLiveOperationStatus =>
    !(HELIUS_RINGS_RETIRED_OPERATION_STATUSES as readonly string[]).includes(status)
);

export function isLiveHeliusRingsOperationStatus(
  status: string
): status is HeliusRingsLiveOperationStatus {
  return (HELIUS_RINGS_LIVE_OPERATION_STATUSES as readonly string[]).includes(status);
}

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
