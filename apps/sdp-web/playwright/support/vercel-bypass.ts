import { type BrowserContext, test as base } from "@playwright/test";
import { getE2EEnv } from "../env";

export { expect } from "@playwright/test";

/**
 * The deployed stage dashboard sits behind Vercel Bot Protection, which
 * challenges headless browsers. A Vercel Firewall custom rule bypasses it for
 * requests that carry this header, read from `SDP_CANARY_BYPASS_TOKEN`
 * (Doppler `stg_ci`). Only requests to the dashboard origin carry it, so Clerk,
 * the API and other third parties never see the value. Runs against a local
 * dashboard add nothing.
 */
export const VERCEL_BYPASS_HEADER = "x-sdp-canary";

/**
 * Adds the bypass header to every request the context makes to the deployed
 * dashboard origin.
 *
 * @param context - The browser context that will load the dashboard.
 * @throws When the run targets a deployed dashboard and the token is unset.
 */
export async function routeVercelBypass(context: BrowserContext): Promise<void> {
  const env = getE2EEnv();
  if (!env.deployedWeb) return;

  const token = process.env.SDP_CANARY_BYPASS_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "SDP_CANARY_BYPASS_TOKEN is required against a deployed dashboard: without it Vercel Bot Protection answers every page with a 429 challenge"
    );
  }

  const dashboard = new URL(env.baseURL).origin;
  await context.route(
    (url) => url.origin === dashboard,
    (route) =>
      route.continue({
        headers: { ...route.request().headers(), [VERCEL_BYPASS_HEADER]: token },
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
