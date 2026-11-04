"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useRef } from "react";
import { clearDashboardSnapshots } from "@/lib/dashboard-snapshot-storage";

/** Observes expiration and sign-out in other tabs as well as the account menu. */
export function DashboardSessionCleanup() {
  const { isLoaded, sessionId } = useAuth();
  const previousSession = useRef(sessionId);

  useEffect(() => {
    if (!isLoaded) return;
    if (!sessionId || previousSession.current !== sessionId) {
      clearDashboardSnapshots();
    }
    previousSession.current = sessionId;
  }, [isLoaded, sessionId]);

  return null;
}
