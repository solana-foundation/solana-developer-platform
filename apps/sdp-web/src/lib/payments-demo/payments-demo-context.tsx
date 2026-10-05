"use client";

import { createContext, useContext } from "react";

/** What the server knows about demo mode when the page is drawn. */
export type PaymentsDemoState = {
  /** The project the demo cookie names, or null when demo mode is off. */
  demoProjectId: string | null;
  /** The project cookie, which stands in when the project list didn't load. */
  cookieProjectId: string | null;
};

/** The project the demo applies to: the selected one, or the project cookie's. */
export function paymentsDemoProjectId(
  state: PaymentsDemoState,
  selectedProjectId: string | null
): string | null {
  return selectedProjectId ?? state.cookieProjectId;
}

/** Whether the demo cookie names the project the dashboard is on. */
export function isPaymentsDemoOn(
  state: PaymentsDemoState,
  selectedProjectId: string | null
): boolean {
  const projectId = paymentsDemoProjectId(state, selectedProjectId);
  return projectId !== null && state.demoProjectId === projectId;
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

/**
 * How often an Issuance screen re-reads a deploy in flight in demo mode: half the demo deploy's
 * 4 seconds, so the token turns live on the read after it lands rather than up to 5s later.
 */
export const DEMO_DEPLOY_POLL_MS = 2_000;
