import { expect, test } from "@playwright/test";
import { resolveSdpReleaseChannel } from "@sdp/types";
import { projectHref } from "@/lib/dashboard-project-path";
import { provisionLinkedOrgProjects } from "../support/local-dashboard-bootstrap";
import { isModuleServed } from "../support/release-channel";

const privateChannelsEnabled = isModuleServed(
  resolveSdpReleaseChannel(process.env.SDP_RELEASE_CHANNEL),
  "private_channels"
);

test.describe
  .serial("dashboard private channels release channel gate", () => {
    let bootstrapProjectId = "";

    test.beforeAll(async ({ browser }) => {
      bootstrapProjectId = (await provisionLinkedOrgProjects(browser)).sandbox;
    });

    test("hides private channels in a release channel without Private Channels", async ({
      page,
    }) => {
      test.skip(privateChannelsEnabled, "Covered by the in-channel private channels test");

      await page.goto(projectHref(bootstrapProjectId, "/dashboard/payments"));
      await expect(page.getByRole("link", { name: "Private Channels" })).toHaveCount(0);

      await page.goto(projectHref(bootstrapProjectId, "/dashboard/integrations"));
      await expect(page.getByRole("link", { name: "Private Channels" })).toHaveCount(0);

      await page.goto(projectHref(bootstrapProjectId, "/dashboard/integrations/private-channels"));
      await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    });

    test("shows private channels where the release channel includes Private Channels", async ({
      page,
    }) => {
      test.skip(!privateChannelsEnabled, "Requires a release channel with Private Channels");

      await page.goto(projectHref(bootstrapProjectId, "/dashboard/integrations"));
      await expect(page.getByRole("link", { name: "Private Channels" })).toBeVisible();
      await page.getByRole("link", { name: "Private Channels" }).click();
      await expect(page).toHaveURL(
        projectHref(bootstrapProjectId, "/dashboard/integrations/private-channels")
      );

      await page.getByRole("link", { name: "Configure" }).click();
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
      test.skip(!privateChannelsEnabled, "Requires a release channel with Private Channels");

      // API Playground is `requiresActive: false` — reachable before any instance
      // is connected because the /instance endpoints are what the operator needs
      // to bootstrap. Regressing that flag would strand the tab behind the
      // Overview redirect chain and make the sandbox constants unreachable.
      await page.goto(
        projectHref(bootstrapProjectId, "/dashboard/integrations/private-channels/api-playground")
      );

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
