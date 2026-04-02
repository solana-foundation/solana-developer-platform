import { expect, test } from "@playwright/test";
import { isClosedAuthEntryMode } from "../support/auth-entry-mode";

test.describe("public auth entry closed e2e", () => {
  test.skip(!isClosedAuthEntryMode(), "This suite covers the disabled auth entry mode.");

  test("direct sign-in link stays closed and redirects home", async ({ page }) => {
    await page.goto("/sign-in");

    await expect(page).toHaveURL("/");
    await expect(page.getByRole("link", { name: "Join the waitlist" })).toBeVisible();
  });

  test("direct sign-up link stays closed and redirects home", async ({ page }) => {
    await page.goto("/sign-up");

    await expect(page).toHaveURL("/");
    await expect(page.getByRole("link", { name: "Join the waitlist" })).toBeVisible();
  });

  test("signed-out dashboard traffic redirects home before the dashboard shell renders", async ({
    page,
  }) => {
    await page.goto("/dashboard");

    await expect(page).toHaveURL("/");
    await expect(page.getByText("Loading dashboard...")).toHaveCount(0);
  });
});
