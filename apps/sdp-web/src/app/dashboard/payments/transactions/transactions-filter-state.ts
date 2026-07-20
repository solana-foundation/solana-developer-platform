import type { TransactionFilters } from "./transactions-query";
import { parseTransactionFilters, serializeTransactionFilters } from "./transactions-query";

export interface DeferredFilterInputState {
  value: string;
  dirty: boolean;
}

export function transactionFiltersKey(filters: TransactionFilters): string {
  return serializeTransactionFilters(filters).toString();
}

export interface ReturnedTransactionFilterSync {
  apply: boolean;
  forceDeferredInputs: boolean;
}

function parseLocationFilters(search: string, returnedSnapshot: string): TransactionFilters {
  return parseTransactionFilters(
    Object.fromEntries(new URLSearchParams(search)),
    new Date(returnedSnapshot)
  );
}

/**
 * Reconciles an RSC filter payload with both the latest requested state and the
 * browser URL. The URL check lets an intentional same-path navigation clear a
 * query while still rejecting an older response after newer typing navigated
 * to a different query.
 */
export function resolveReturnedTransactionFilterSync(
  returned: TransactionFilters,
  desired: TransactionFilters,
  options: { browserNavigation?: boolean; currentSearch?: string } = {}
): ReturnedTransactionFilterSync {
  const browserNavigation = options.browserNavigation ?? false;
  const returnedMatchesDesired = transactionFiltersKey(returned) === transactionFiltersKey(desired);
  const returnedMatchesLocation =
    options.currentSearch !== undefined &&
    transactionFiltersKey(parseLocationFilters(options.currentSearch, returned.snapshot)) ===
      transactionFiltersKey(returned);
  const apply =
    options.currentSearch === undefined
      ? browserNavigation || returnedMatchesDesired
      : returnedMatchesLocation;

  return {
    apply,
    forceDeferredInputs: apply && (browserNavigation || !returnedMatchesDesired),
  };
}

export function shouldApplyReturnedTransactionFilters(
  returned: TransactionFilters,
  desired: TransactionFilters,
  browserNavigation = false,
  currentSearch?: string
): boolean {
  return resolveReturnedTransactionFilterSync(returned, desired, {
    browserNavigation,
    currentSearch,
  }).apply;
}

export function reconcileDeferredFilterInput(
  current: DeferredFilterInputState,
  returnedValue: string | undefined,
  force = false
): DeferredFilterInputState {
  const nextValue = returnedValue ?? "";
  if (force || !current.dirty || current.value.trim() === nextValue) {
    return { value: nextValue, dirty: false };
  }
  return current;
}
