"use client";

import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

type PaymentKindState = {
  /** The kind on the bench's stage (an index into `PAYMENT_KINDS`). */
  kind: number;
  /** How many times the bench has handed the stage on; the bubble beats on each. */
  shows: number;
  show: (kind: number) => void;
};

const PaymentKindContext = createContext<PaymentKindState | null>(null);

/** The bench moves the bubble along: both read the kind on the stage from here. */
export function PaymentKindProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState({ kind: 0, shows: 0 });
  const show = useCallback((kind: number) => {
    setState((previous) => ({ kind, shows: previous.shows + 1 }));
  }, []);
  const value = useMemo(() => ({ ...state, show }), [state, show]);
  return <PaymentKindContext.Provider value={value}>{children}</PaymentKindContext.Provider>;
}

export function usePaymentKind(): PaymentKindState {
  const value = useContext(PaymentKindContext);
  if (!value) throw new Error("usePaymentKind must be used within PaymentKindProvider");
  return value;
}
