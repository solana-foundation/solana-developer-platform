import { expect, test } from "@playwright/test";

test.use({
  storageState: "playwright/.clerk/user.json",
});

test("@smoke admin user can connect to the dashboard", async ({ page }) => {
  await page.goto("/dashboard");

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Wallets" })).toBeVisible();
});
