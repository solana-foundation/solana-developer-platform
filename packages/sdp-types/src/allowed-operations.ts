/**
 * Allowed Operations (ADR 0006).
 *
 * An API key may carry a list of the operation families and types it is
 * allowed to perform on the custody wallets it can access. An empty or
 * missing list places no restriction. An operation that is not in a
 * non-empty list is refused before anything executes.
 *
 * The vocabulary is the one value-moving routes already declare. A family
 * entry covers every type in that family.
 */

export const OPERATION_FAMILIES = ["privacy", "payment", "ramp", "issuance", "program"] as const;

export type OperationFamily = (typeof OPERATION_FAMILIES)[number];

export const OPERATION_TYPES = [
  // payment
  "payment_transfer_execute",
  "payment_transfer_batch_execute",
  "recurring_payment_create",
  "recurring_payment_update",
  "recurring_payment_collection",
  // ramp
  "ramp_onramp_quote",
  "ramp_offramp_quote",
  // issuance
  "issuance_allowlist_add_execute",
  "issuance_allowlist_remove_execute",
  "issuance_burn_execute",
  "issuance_deploy_execute",
  "issuance_force_burn_execute",
  "issuance_freeze_execute",
  "issuance_metadata_update_execute",
  "issuance_mint_execute",
  "issuance_pause_execute",
  "issuance_seize_execute",
  "issuance_unfreeze_execute",
  "issuance_unpause_execute",
  "issuance_update_authority_execute",
  // program
  "dvp_fund",
  "dvp_settle",
  "earn_vault_deposit",
  "earn_vault_withdrawal",
  "earn_program_withdrawal",
  // privacy (private operations through Helius Rings)
  "rings_shield",
  "rings_transfer_registered",
  "rings_transfer_anonymous",
  "rings_withdraw",
  "rings_merge",
  "rings_timelock_create",
  "rings_timelock_settle",
  "rings_zone_create",
  "rings_ring_exit",
  "rings_ring_entry",
] as const;

export type OperationType = (typeof OPERATION_TYPES)[number];

export const OPERATION_FAMILY_BY_TYPE = {
  payment_transfer_execute: "payment",
  payment_transfer_batch_execute: "payment",
  recurring_payment_create: "payment",
  recurring_payment_update: "payment",
  recurring_payment_collection: "payment",
  ramp_onramp_quote: "ramp",
  ramp_offramp_quote: "ramp",
  issuance_allowlist_add_execute: "issuance",
  issuance_allowlist_remove_execute: "issuance",
  issuance_burn_execute: "issuance",
  issuance_deploy_execute: "issuance",
  issuance_force_burn_execute: "issuance",
  issuance_freeze_execute: "issuance",
  issuance_metadata_update_execute: "issuance",
  issuance_mint_execute: "issuance",
  issuance_pause_execute: "issuance",
  issuance_seize_execute: "issuance",
  issuance_unfreeze_execute: "issuance",
  issuance_unpause_execute: "issuance",
  issuance_update_authority_execute: "issuance",
  dvp_fund: "program",
  dvp_settle: "program",
  earn_vault_deposit: "program",
  earn_vault_withdrawal: "program",
  earn_program_withdrawal: "program",
  rings_shield: "privacy",
  rings_transfer_registered: "privacy",
  rings_transfer_anonymous: "privacy",
  rings_withdraw: "privacy",
  rings_merge: "privacy",
  rings_timelock_create: "privacy",
  rings_timelock_settle: "privacy",
  rings_zone_create: "privacy",
  rings_ring_exit: "privacy",
  rings_ring_entry: "privacy",
} as const satisfies Record<OperationType, OperationFamily>;

/** Every value an `allowedOperations` list may hold: a family or a type. */
export const ALLOWED_OPERATIONS = [...OPERATION_FAMILIES, ...OPERATION_TYPES] as const;

export type AllowedOperation = (typeof ALLOWED_OPERATIONS)[number];

export function isOperationFamily(value: string): value is OperationFamily {
  return (OPERATION_FAMILIES as readonly string[]).includes(value);
}

export function isOperationType(value: string): value is OperationType {
  return (OPERATION_TYPES as readonly string[]).includes(value);
}

export function isAllowedOperation(value: string): value is AllowedOperation {
  return isOperationFamily(value) || isOperationType(value);
}

export function operationFamilyOf(operationType: OperationType): OperationFamily {
  return OPERATION_FAMILY_BY_TYPE[operationType];
}

export function operationTypesInFamily(family: OperationFamily): OperationType[] {
  return OPERATION_TYPES.filter((type) => OPERATION_FAMILY_BY_TYPE[type] === family);
}

/**
 * Whether a key with this list may perform the operation. An empty or missing
 * list is unrestricted. Otherwise the type itself or its family must be listed.
 */
export function isOperationAllowed(
  allowedOperations: readonly AllowedOperation[] | null | undefined,
  operationType: OperationType
): boolean {
  if (!allowedOperations || allowedOperations.length === 0) {
    return true;
  }
  return (
    allowedOperations.includes(operationType) ||
    allowedOperations.includes(operationFamilyOf(operationType))
  );
}

/**
 * Whether every entry of `requested` is covered by `granted`. An empty or
 * missing `granted` list is unrestricted and covers anything. A requested
 * family needs that family in `granted`; a requested type needs the type or
 * its family. Used so a key cannot mint or rotate a key with wider rights
 * than its own.
 */
export function isAllowedOperationsWithin(
  granted: readonly AllowedOperation[] | null | undefined,
  requested: readonly AllowedOperation[] | null | undefined
): boolean {
  if (!granted || granted.length === 0) {
    return true;
  }
  if (!requested || requested.length === 0) {
    // An unrestricted key is wider than any restricted one.
    return false;
  }
  return requested.every((entry) =>
    isOperationFamily(entry) ? granted.includes(entry) : isOperationAllowed(granted, entry)
  );
}

/** Stable storage form: unique entries, sorted. */
export function normalizeAllowedOperations(
  allowedOperations: readonly AllowedOperation[]
): AllowedOperation[] {
  return Array.from(new Set(allowedOperations)).sort();
}
