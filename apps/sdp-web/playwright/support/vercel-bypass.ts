import { type BrowserContext, test as base } from "@playwright/test";
import { getE2EEnv } from "@/playwright/env";

/**
 * The deployed stage dashboard sits behind Vercel Bot Protection, which
 * challenges headless browsers. A Vercel Firewall custom rule bypasses it for
 * requests that carry this header, whose value `getE2EEnv` parses from
 * `SDP_CANARY_BYPASS_TOKEN` (Doppler `stg_ci`). Only requests to the dashboard
 * origin carry it, so Clerk, the API and other third parties never see the
 * value. Runs against a local dashboard add nothing.
 */
export const VERCEL_BYPASS_HEADER = "x-sdp-canary";

/**
 * Adds the bypass header to every request the context makes to the deployed
 * dashboard origin.
 *
 * @param context - The browser context that will load the dashboard.
 */
export async function routeVercelBypass(context: BrowserContext): Promise<void> {
  const { baseURL, vercelBypassToken } = getE2EEnv();
  if (!vercelBypassToken) return;

  const dashboard = new URL(baseURL).origin;
  await context.route(
    (url) => url.origin === dashboard,
    (route) =>
      route.continue({
        headers: { ...route.request().headers(), [VERCEL_BYPASS_HEADER]: vercelBypassToken },
      })
  );
}

/** `test` whose context, and so its `page`, carries the bypass header to the deployed dashboard. */
export const test = base.extend({
  context: async ({ context }, use) => {
    await routeVercelBypass(context);
    await use(context);
  },
});
