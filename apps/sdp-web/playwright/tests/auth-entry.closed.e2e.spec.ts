import { expect, test } from "@playwright/test";

function isClosedMode(): boolean {
  const signInEnabled = process.env.PLAYWRIGHT_SDP_SIGN_IN_ENTRY_ENABLED;
  const signUpEnabled = process.env.PLAYWRIGHT_SDP_SIGN_UP_ENTRY_ENABLED;

  return signInEnabled === "false" && signUpEnabled === "false";
}

test.describe("public auth entry closed e2e", () => {
  test.skip(!isClosedMode(), "This suite covers the disabled auth entry mode.");

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
