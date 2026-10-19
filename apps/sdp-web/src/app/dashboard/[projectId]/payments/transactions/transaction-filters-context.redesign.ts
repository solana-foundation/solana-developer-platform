import { createContext, useContext } from "react";
import type { TransactionFilters } from "./transactions-query.redesign";

export interface TransactionContextValue {
  filters: TransactionFilters;
  pending: boolean;
  /** Replaces the whole filter set, cursors included; pagination's entry point. */
  navigate: (next: TransactionFilters) => void;
  /** Applies filter changes and drops back to the first page. */
  update: (changes: Partial<TransactionFilters>) => void;
}

/** The filter state the transactions workspace provides to its results table. */
export const TransactionContext = createContext<TransactionContextValue | null>(null);

/**
 * Reads the filter state from the enclosing transactions workspace.
 * @returns the workspace's filters, pending flag, and navigation callbacks
 */
export function useTransactionFilters(): TransactionContextValue {
  const value = useContext(TransactionContext);
  if (value === null) throw new Error("Transaction filter context is missing");
  return value;
}
