import { expect, test } from "@playwright/test";
import {
  ensureLinkedOrg,
  getBootstrapApiBaseUrl,
  provisionWithAdminSession,
  resolvePlaywrightProjectId,
  seedProjectCookie,
} from "../support/local-dashboard-bootstrap";

// The dashboard gates on the `private-channels` Vercel flag, whose default falls
// back to PRIVATE_CHANNELS_ENABLED. Local Playwright runs have no Vercel provider,
// so the env var alone decides. Mirror the flagDefault() truthiness vocabulary
// from src/flags.ts so "1"/"yes"/"on" behave the same as "true".
const privateChannelsEnabled = ["1", "true", "yes", "on"].includes(
  process.env.PRIVATE_CHANNELS_ENABLED?.trim().toLowerCase() ?? ""
);

test.describe
  .serial("dashboard private channels feature flag", () => {
    let bootstrapProjectId = "";

    test.beforeAll(async ({ browser }) => {
      bootstrapProjectId = await provisionWithAdminSession(browser, async (session) => {
        await ensureLinkedOrg(session.identity, { tier: "enterprise" });
        return resolvePlaywrightProjectId(getBootstrapApiBaseUrl(), session.getBearerToken);
      });
    });

    test.beforeEach(async ({ page }) => {
      await seedProjectCookie(page, bootstrapProjectId);
    });

    test("hides private channels when the dashboard feature flag is disabled", async ({ page }) => {
      test.skip(privateChannelsEnabled, "Covered by the feature-enabled private channels test");

      await page.goto("/dashboard/payments");
      await expect(page.getByRole("link", { name: "Private Channels" })).toHaveCount(0);

      await page.goto("/dashboard/integrations");
      await expect(page.getByRole("link", { name: "Private Channels" })).toHaveCount(0);

      await page.goto("/dashboard/integrations/private-channels");
      await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    });

    test("shows private channels when the dashboard feature flag is enabled", async ({ page }) => {
      test.skip(!privateChannelsEnabled, "Requires PRIVATE_CHANNELS_ENABLED=true");

      await page.goto("/dashboard/integrations");
      await expect(page.getByRole("link", { name: "Private Channels" })).toBeVisible();
      await page.getByRole("link", { name: "Private Channels" }).click();
      await expect(page).toHaveURL(/\/dashboard\/integrations\/private-channels$/);

      await page.getByRole("link", { name: "Configure" }).click();
      await expect(page).toHaveURL(/\/dashboard\/integrations\/private-channels\/setup$/);

      await expect(
        page.locator("main").getByText("Connect Private Channel", { exact: true })
      ).toBeVisible();

      const gatewayInput = page.locator("#gateway-url");
      await expect(gatewayInput).toBeVisible();
      await expect(gatewayInput).toHaveValue("http://34.71.147.163:8899");

      const testButton = page.getByRole("button", { name: "Test connection", exact: true });
      await expect(testButton).toBeVisible();
      await expect(testButton).toBeEnabled();

      const connectButton = page.getByRole("button", { name: "Connect", exact: true });
      await expect(connectButton).toBeVisible();
      await expect(connectButton).toBeEnabled();

      // Clearing a required field disables Connect and surfaces the inline error.
      await gatewayInput.fill("");
      await expect(connectButton).toBeDisabled();
      await expect(page.getByText("Gateway URL is required.")).toBeVisible();

      // Setting an invalid URL keeps Connect disabled with a format error.
      await gatewayInput.fill("not-a-url");
      await expect(connectButton).toBeDisabled();
      await expect(page.getByText("Gateway URL must be a valid http/https URL.")).toBeVisible();

      // Restoring a valid value re-enables Connect and clears the error.
      await gatewayInput.fill("http://34.71.147.163:8899");
      await expect(connectButton).toBeEnabled();
      await expect(page.getByText("Gateway URL is required.")).toHaveCount(0);
    });

    test("renders the API Playground tab without a connected instance", async ({ page }) => {
      test.skip(!privateChannelsEnabled, "Requires PRIVATE_CHANNELS_ENABLED=true");

      // API Playground is `requiresActive: false` — reachable before any instance
      // is connected because the /instance endpoints are what the operator needs
      // to bootstrap. Regressing that flag would strand the tab behind the
      // Overview redirect chain and make the sandbox constants unreachable.
      await page.goto("/dashboard/integrations/private-channels/api-playground");

      await expect(page.getByRole("button", { name: "API Playground" })).toBeVisible();

      // The shell's method+title chip renders the default endpoint. Ownership
      // check: this is the SPC playground, not somebody else's.
      await expect(page.getByText("Get instance", { exact: true })).toBeVisible();

      // Bottom action bar — the "cut off" regression that motivated the layout
      // fix. If either button is missing, the shell height chain is broken.
      await expect(page.getByRole("button", { name: /Run request/i })).toBeVisible();
      await expect(page.getByRole("button", { name: /Copy Code/i })).toBeVisible();
    });
  });
