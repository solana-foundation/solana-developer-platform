"use client";

import { createContext, useContext } from "react";

/** What the server knows about demo mode when the page is drawn. */
export type PaymentsDemoState = {
  /** The project the demo cookie names, or null when demo mode is off. */
  demoProjectId: string | null;
};

/** Whether the demo cookie names the project in the page's URL. */
export function isPaymentsDemoOn(state: PaymentsDemoState, projectId: string): boolean {
  return state.demoProjectId === projectId;
}

const PaymentsDemoContext = createContext(false);

/** Set by the dashboard shell: true on a Payments screen running in demo mode. */
export const PaymentsDemoProvider = PaymentsDemoContext.Provider;

/**
 * Whether this Payments screen runs in demo mode, so its forms can start filled in and its
 * provider steps can stand in for checkouts that would open elsewhere.
 */
export function usePaymentsDemo(): boolean {
  return useContext(PaymentsDemoContext);
}
