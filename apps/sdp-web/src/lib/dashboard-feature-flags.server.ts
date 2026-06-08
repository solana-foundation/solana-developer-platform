import { cookies } from "next/headers";
import {
  DASHBOARD_PAYMENTS_V2_OVERRIDE_COOKIE_NAME,
  type DashboardFeatureFlags,
  resolveDashboardFeatureFlags,
} from "./dashboard-feature-flags";

export async function getDashboardFeatureFlags(): Promise<DashboardFeatureFlags> {
  const store = await cookies();
  const overrideCookie = store.get(DASHBOARD_PAYMENTS_V2_OVERRIDE_COOKIE_NAME);

  return resolveDashboardFeatureFlags(overrideCookie?.value);
}
