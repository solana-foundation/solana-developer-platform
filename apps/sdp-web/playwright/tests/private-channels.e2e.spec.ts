import { expect, test } from "@playwright/test";
import { projectHref } from "@/lib/dashboard-project-path";
import { provisionLinkedOrgProjects } from "../support/local-dashboard-bootstrap";

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
      bootstrapProjectId = (await provisionLinkedOrgProjects(browser)).sandbox;
    });

    test("hides private channels when the dashboard feature flag is disabled", async ({ page }) => {
      test.skip(privateChannelsEnabled, "Covered by the feature-enabled private channels test");

      await page.goto(projectHref(bootstrapProjectId, "/dashboard/payments"));
      await expect(page.getByRole("link", { name: "Private Channels" })).toHaveCount(0);

      await page.goto(projectHref(bootstrapProjectId, "/dashboard/integrations"));
      await expect(page.getByRole("link", { name: /^Privacy / })).toHaveCount(0);

      await page.goto(projectHref(bootstrapProjectId, "/dashboard/integrations?tab=privacy"));
      await expect(page.getByRole("link", { name: "Private Channels" })).toHaveCount(0);

      await page.goto(projectHref(bootstrapProjectId, "/dashboard/integrations/private-channels"));
      await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    });

    test("shows private channels when the dashboard feature flag is enabled", async ({ page }) => {
      test.skip(!privateChannelsEnabled, "Requires PRIVATE_CHANNELS_ENABLED=true");

      await page.goto(projectHref(bootstrapProjectId, "/dashboard/integrations"));
      await page.getByRole("link", { name: /^Privacy / }).click();
      await expect(page).toHaveURL(
        projectHref(bootstrapProjectId, "/dashboard/integrations?tab=privacy")
      );
      await expect(page.getByRole("link", { name: "Private Channels" })).toBeVisible();
      await page.getByRole("link", { name: "Private Channels" }).click();
      await expect(page).toHaveURL(
        projectHref(bootstrapProjectId, "/dashboard/integrations/private-channels/overview")
      );

      await page.getByRole("link", { name: "Add channel" }).click();
      await expect(page).toHaveURL(
        projectHref(bootstrapProjectId, "/dashboard/integrations/private-channels/setup")
      );

      await expect(
        page.locator("main").getByRole("heading", { name: "Privacy", exact: true })
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

      // Invalid values disable Connect; Test connection surfaces validation before any probe.
      await gatewayInput.fill("");
      await expect(connectButton).toBeDisabled();
      await testButton.click();
      await expect(page.getByText("Gateway URL is required.")).toBeVisible();

      // Setting an invalid URL keeps Connect disabled with a format error.
      await gatewayInput.fill("not-a-url");
      await expect(connectButton).toBeDisabled();
      await testButton.click();
      await expect(page.getByText("Gateway URL must be a valid http/https URL.")).toBeVisible();

      // Restoring a valid value re-enables Connect and clears the error.
      await gatewayInput.fill("http://34.71.147.163:8899");
      await expect(connectButton).toBeEnabled();
      await expect(page.getByText("Gateway URL is required.")).toHaveCount(0);
    });

    test("legacy API Playground link opens the channel directory without a connection", async ({
      page,
    }) => {
      test.skip(!privateChannelsEnabled, "Requires PRIVATE_CHANNELS_ENABLED=true");

      await page.goto(
        projectHref(bootstrapProjectId, "/dashboard/integrations/private-channels/api-playground")
      );
      await expect(page).toHaveURL(
        `${projectHref(bootstrapProjectId, "/dashboard/integrations/private-channels/overview")}?tab=playground`
      );
      await expect(page.getByRole("heading", { name: "Channels", exact: true })).toBeVisible();
      await expect(page.getByText("No private channels yet.", { exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Add channel" })).toHaveAttribute(
        "href",
        projectHref(bootstrapProjectId, "/dashboard/integrations/private-channels/setup")
      );
    });
  });
