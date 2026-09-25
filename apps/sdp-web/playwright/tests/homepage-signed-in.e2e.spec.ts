import { expect, test } from "@playwright/test";

// Runs in the dashboard project, with its signed-in session (auth.global.setup.ts).
test.describe("homepage, signed in", () => {
  test("takes a signed-in visitor to the dashboard instead of offering sign-in", async ({
    page,
  }) => {
    await page.goto("/");
    const banner = page.getByRole("banner");

    await expect(banner.getByRole("link", { name: "Sign in" })).toHaveCount(0);
    await expect(banner.getByRole("link", { name: "Create account" })).toHaveCount(0);
    // getByRole skips the closed Docs panel, which has a "Dashboard" link of its own.
    await expect(banner.getByRole("link", { name: "Dashboard" })).toHaveAttribute(
      "href",
      "/dashboard"
    );
    await expect(page.locator("#top").getByRole("link", { name: "Dashboard" })).toHaveAttribute(
      "href",
      "/dashboard"
    );
  });
});
