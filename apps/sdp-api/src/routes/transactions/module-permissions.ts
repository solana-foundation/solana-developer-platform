import type { Action } from "@sdp/types/actions";
import type { Permission } from "@sdp/types/permissions";
import {
  PAYMENT_TRANSACTION_KINDS,
  type PaymentTransactionKind,
  UNIFIED_TRANSACTION_MODULES,
  type UnifiedTransactionModule,
} from "@sdp/types/unified-transactions";

/**
 * The action that shows each module's rows in the unified list. Payments rows
 * are what the route's own action (`transactions.read`) covers, each kind
 * narrowed further by {@link PAYMENT_TRANSACTION_KIND_ACTIONS}; every other
 * module's rows also need that module's read.
 */
export const UNIFIED_TRANSACTION_MODULE_ACTIONS = {
  payments: "transactions.read",
  earn: "earn.read",
  dvp: "dvp.read",
  private_channels: "private_channels.read",
  issuance: "issuance.read",
  rings: "helius_rings.read",
} as const satisfies Record<UnifiedTransactionModule, Action>;

/**
 * The read that shows each kind of Payments row, beside `transactions.read`:
 * the feed never shows a transfer, a batch item, a recurring collection, a
 * payment request's fulfilment or a ramp transfer to a caller that could not
 * read it from its own module.
 */
export const PAYMENT_TRANSACTION_KIND_ACTIONS = {
  pay: "transfers.read",
  confidential_pay: "transfers.read",
  deposit: "transfers.read",
  batch_pay: "transfer_batches.read",
  recurring_pay: "recurring.read",
  request_deposit: "payment_requests.read",
  onramp: "onramp.read",
  offramp: "offramp.read",
} as const satisfies Record<PaymentTransactionKind, Action>;

/** The kinds of Payments row a caller may see, given whether it may perform each action. */
export function permittedPaymentTransactionKinds(
  mayPerform: (action: Action) => boolean
): PaymentTransactionKind[] {
  return PAYMENT_TRANSACTION_KINDS.filter((kind) =>
    mayPerform(PAYMENT_TRANSACTION_KIND_ACTIONS[kind])
  );
}

/**
 * The wallet-binding permission that scopes each module's rows to a key's
 * selected wallets. Wallet bindings keep the permission vocabulary until the
 * wallet-scope work replaces it.
 */
export const UNIFIED_TRANSACTION_MODULE_PERMISSIONS = {
  payments: "payments:read",
  earn: "earn:read",
  dvp: "wallets:read",
  private_channels: "payments:read",
  issuance: "tokens:read",
  rings: "payments:read",
} as const satisfies Record<UnifiedTransactionModule, Permission>;

/** The modules whose rows a caller may see, given whether it may perform each action. */
export function permittedUnifiedTransactionModules(
  mayPerform: (action: Action) => boolean
): UnifiedTransactionModule[] {
  return UNIFIED_TRANSACTION_MODULES.filter((module) =>
    mayPerform(UNIFIED_TRANSACTION_MODULE_ACTIONS[module])
  );
}
