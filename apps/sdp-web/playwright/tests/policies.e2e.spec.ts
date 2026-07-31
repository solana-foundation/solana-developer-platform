import { expect, test } from "@playwright/test";
import { getPlaywrightAdminSession } from "../support/auth-session";
import { createLocalApiClient } from "../support/local-api-client";
import {
  bootstrapLocalWalletFixtures,
  ensureLinkedOrg,
  getBootstrapApiBaseUrl,
  resolvePlaywrightProjectId,
  seedProjectCookie,
} from "../support/local-dashboard-bootstrap";

const E2E_TIMEOUT_MS = 180_000;

test.describe("policies responsive table", () => {
  let projectId = "";

  test.beforeAll(async ({ browser }) => {
    const session = await getPlaywrightAdminSession(browser);

    try {
      await ensureLinkedOrg(session.identity, { tier: "enterprise" });
      const fixtures = await bootstrapLocalWalletFixtures({
        identity: session.identity,
        bearerToken: session.getBearerToken,
        provider: "privy",
        walletCount: 1,
        walletLabel: `Policies responsive ${Date.now().toString(36).toUpperCase()}`,
        tier: "enterprise",
      });
      const wallet = fixtures.wallets[0];
      if (!wallet) {
        throw new Error("Failed to create a wallet for Policies responsive coverage");
      }

      projectId = await resolvePlaywrightProjectId(
        getBootstrapApiBaseUrl(),
        session.getBearerToken
      );
      const api = createLocalApiClient(getBootstrapApiBaseUrl(), session.getBearerToken, projectId);
      await api.put(`/v1/payments/wallets/${encodeURIComponent(wallet.walletId)}/policies`, {
        destinationAllowlist: [],
        maxTransferAmount: "25",
      });
    } finally {
      await session.page.close();
    }
  });

  test.beforeEach(async ({ page }) => {
    await seedProjectCookie(page, projectId);
  });

  test("uses cards on phones and progressively reveals table columns without overflow", async ({
    page,
  }) => {
    const desktopInventory = page.locator("[data-desktop-inventory]");
    const mobileInventory = page.locator("[data-mobile-inventory]");
    const column = (name: string) => page.locator("th").filter({ hasText: name });
    const expectNoOverflow = async () => {
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        .toBe(true);
    };

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/dashboard/policies", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Policies" })).toBeVisible({
      timeout: E2E_TIMEOUT_MS,
    });
    await expect(mobileInventory).toBeVisible({ timeout: E2E_TIMEOUT_MS });
    await expect(desktopInventory).toBeHidden();
    await expectNoOverflow();

    await page.setViewportSize({ width: 1024, height: 900 });
    await expect(desktopInventory).toBeVisible();
    await expect(mobileInventory).toBeHidden();
    await expect(column("Rules")).toBeHidden();
    await expect(column("Bindings")).toBeHidden();
    await expect(column("Last updated")).toBeHidden();
    await expectNoOverflow();

    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(column("Rules")).toBeVisible();
    await expect(column("Bindings")).toBeHidden();
    await expect(column("Last updated")).toBeHidden();
    await expectNoOverflow();

    await page.setViewportSize({ width: 1536, height: 900 });
    await expect(column("Rules")).toBeVisible();
    await expect(column("Bindings")).toBeVisible();
    await expect(column("Last updated")).toBeVisible();
    await expectNoOverflow();
  });
});
