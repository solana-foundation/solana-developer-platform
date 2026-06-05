"use client";

import { useEffect } from "react";
import {
  DASHBOARD_PAYMENTS_V2_OVERRIDE_COOKIE_NAME,
  DASHBOARD_PAYMENTS_V2_OVERRIDE_COOKIE_VALUES,
  type DashboardFeatureFlags,
} from "@/lib/dashboard-feature-flags";

type DashboardFeatureFlagsConsole = {
  getPaymentsV2: () => boolean;
  setPaymentsV2: (enabled: boolean) => void;
};

declare global {
  interface Window {
    sdpDashboardFeatureFlags: DashboardFeatureFlagsConsole;
  }
}

const OVERRIDE_COOKIE_MAX_AGE_SECONDS = 31_536_000;

function getCookieAttributes(maxAgeSeconds: number): string {
  const secureAttribute = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax${secureAttribute}`;
}

function writePaymentsV2Override(enabled: boolean): void {
  const value = enabled
    ? DASHBOARD_PAYMENTS_V2_OVERRIDE_COOKIE_VALUES.enabled
    : DASHBOARD_PAYMENTS_V2_OVERRIDE_COOKIE_VALUES.disabled;
  document.cookie = `${DASHBOARD_PAYMENTS_V2_OVERRIDE_COOKIE_NAME}=${value}${getCookieAttributes(
    OVERRIDE_COOKIE_MAX_AGE_SECONDS
  )}`;
  window.location.reload();
}

export function DashboardFeatureFlagsConsoleBridge({
  featureFlags,
}: {
  featureFlags: DashboardFeatureFlags;
}) {
  useEffect(() => {
    window.sdpDashboardFeatureFlags = {
      getPaymentsV2: () => featureFlags.paymentsV2,
      setPaymentsV2: writePaymentsV2Override,
    };
  }, [featureFlags.paymentsV2]);

  return null;
}
