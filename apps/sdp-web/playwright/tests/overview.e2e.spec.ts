import { expect, type Locator, test } from "@playwright/test";
import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import {
  bootstrapLocalWalletFixtures,
  gotoProjectPage,
  provisionWithAdminSession,
} from "../support/local-dashboard-bootstrap";

async function requireBox(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error("Expected the element to be rendered");
  }
  return box;
}

test.describe("overview census", () => {
  let projectId = "";

  test.beforeAll(async ({ browser }) => {
    const fixtures = await provisionWithAdminSession(browser, (session) =>
      bootstrapLocalWalletFixtures({
        identity: session.identity,
        bearerToken: session.getBearerToken,
        walletCount: 1,
      })
    );
    projectId = fixtures.projectId;
  });

  test("today's volume landing moves nothing at phone width", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    // A saved snapshot would draw the figure on first paint; the census has to start at its dash.
    await page.addInitScript(() => {
      for (const key of Object.keys(window.localStorage)) {
        if (key.endsWith(".home-activity")) window.localStorage.removeItem(key);
      }
    });
    // Hold the read until the dash is measured, then answer with a figure that wrapped the
    // previous one-line census at this width.
    const activityRead = Promise.withResolvers<void>();
    await page.route(/\/api\/dashboard\/home\/activity$/, async (route) => {
      await activityRead.promise;
      await route.fulfill({
        json: {
          data: {
            activityRows: [],
            activityError: null,
            activityNotice: null,
            // USDC is a well-known stablecoin, so the figure prices without a balance row.
            todaysVolume: {
              transferCount: 1,
              amountByMint: { [WELL_KNOWN_TOKENS.USDC.mints.devnet.address]: "123456789" },
              complete: true,
              coversDay: true,
            },
            todaysVolumeError: null,
          },
        },
      });
    });

    await gotoProjectPage(page, projectId, "/dashboard");
    const section = (name: string) => page.locator(`[data-overview-section="${name}"]`);
    const balance = section("balance");
    const network = section("network");
    const volume = balance.getByRole("link", { name: /today’s volume$/ });
    const census = volume.locator("xpath=..");
    // Measured from the balance column's top, so the quick start settling above it cannot move
    // the sections under test.
    const layout = async () => {
      const [censusBox, balanceBox, networkBox] = await Promise.all([
        requireBox(census),
        requireBox(balance),
        requireBox(network),
      ]);
      return { censusHeight: censusBox.height, networkOffset: networkBox.y - balanceBox.y };
    };

    await expect(volume).toHaveText("— today’s volume", { timeout: 120_000 });
    const loading = await layout();
    activityRead.resolve();
    await expect(volume).toHaveText("$123,456,789.00 today’s volume", { timeout: 30_000 });
    expect(await layout()).toEqual(loading);
  });
});
