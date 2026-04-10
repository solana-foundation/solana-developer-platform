import { expect, test } from "@playwright/test";

test.describe("public auth entry e2e", () => {
  test("signed-out homepage stays in waitlist mode", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("link", { name: "Join the waitlist" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Docs" })).toBeVisible();
  });

  test("direct sign-in link renders for signed-out users", async ({ page }) => {
    await page.goto("/sign-in");

    await expect(page).toHaveURL(/\/sign-in(?:\?.*)?$/);
    await expect(
      page.getByRole("heading", { name: "Sign in to Solana Developer Platform" })
    ).toBeVisible({ timeout: 120_000 });
  });

  test("direct sign-up link renders for signed-out users", async ({ page }) => {
    await page.goto("/sign-up");

    await expect(page).toHaveURL(/\/sign-up(?:\?.*)?$/);
    await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible({
      timeout: 120_000,
    });
  });

  test("signed-out dashboard traffic redirects before the dashboard shell renders", async ({
    page,
  }) => {
    await page.goto("/dashboard");

    await expect(page).toHaveURL(/\/sign-in(?:\?.*)?$/);
    await expect(page.getByText("Loading dashboard...")).toHaveCount(0);
  });
});
