import { expect, test } from "@playwright/test";
import { getPlaywrightAdminSession } from "../support/auth-session";
import { ensureLinkedOrg } from "../support/local-dashboard-bootstrap";

test.describe
  .serial("dashboard wallets e2e", () => {
    test.beforeAll(async ({ browser }) => {
      const session = await getPlaywrightAdminSession(browser);
      await ensureLinkedOrg(session.identity);
      await session.page.close();
    });

    test("user can initialize Privy and run signer check from the wallet detail page", async ({
      page,
    }) => {
      await page.goto("/dashboard/wallets");

      await expect(page.getByText("Create your first wallet", { exact: true })).toBeVisible();

      const privyCard = page.locator("article").filter({
        has: page.getByRole("heading", { name: "Privy" }),
      });
      await privyCard.getByRole("button", { name: "New wallet" }).click();

      await page.getByLabel("Primary wallet label").fill("Treasury");
      await page.getByRole("button", { name: "Create wallet" }).click();

      const walletCard = page.locator("article").filter({
        has: page.getByText("Treasury"),
      });
      await expect(walletCard).toBeVisible({ timeout: 120_000 });

      await walletCard.getByRole("link", { name: "Manage" }).click();
      await expect(page).toHaveURL(/\/dashboard\/wallets\/.+/);

      await page.getByRole("button", { name: "Actions" }).click();
      await page.getByRole("menuitem", { name: "Prove ownership" }).click();

      await expect(page.getByText("Signer check sent.")).toBeVisible({ timeout: 120_000 });
      await expect(page.getByRole("link", { name: "View on Solana Explorer" })).toBeVisible();
    });
  });
