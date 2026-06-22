export type DashboardFeatureFlags = {
  paymentsV2: boolean;
};

type PaymentsV2OverrideCookieValue = "enabled" | "disabled";

export const DASHBOARD_FEATURE_FLAGS_DEFAULTS = {
  paymentsV2: true,
} as const satisfies DashboardFeatureFlags;

export const DASHBOARD_PAYMENTS_V2_OVERRIDE_COOKIE_NAME = "sdp_dashboard_payments_v2_override";

export const DASHBOARD_PAYMENTS_V2_OVERRIDE_COOKIE_VALUES = {
  enabled: "enabled",
  disabled: "disabled",
} as const satisfies Record<string, PaymentsV2OverrideCookieValue>;

export function resolveDashboardFeatureFlags(
  paymentsV2Override: string | undefined
): DashboardFeatureFlags {
  if (paymentsV2Override === DASHBOARD_PAYMENTS_V2_OVERRIDE_COOKIE_VALUES.enabled) {
    return { paymentsV2: true };
  }

  if (paymentsV2Override === DASHBOARD_PAYMENTS_V2_OVERRIDE_COOKIE_VALUES.disabled) {
    return { paymentsV2: false };
  }

  return DASHBOARD_FEATURE_FLAGS_DEFAULTS;
}
