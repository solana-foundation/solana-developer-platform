import { expect, test } from "@playwright/test";

test.describe("public auth entry e2e", () => {
  test("signed-out homepage offers self-serve signup and a contact path", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("link", { name: "Try SDP" })).toHaveAttribute("href", "/sign-up");
    await expect(page.getByRole("link", { name: "Contact us" })).toHaveAttribute(
      "href",
      "https://solanafoundation.typeform.com/to/PLfMTDQs"
    );
    await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Docs" })).toBeVisible();
  });

  test("language picker does not shift the header when it opens or closes", async ({ page }) => {
    await page.goto("/");

    const languagePicker = page.getByRole("button", { name: "Language" });
    const dashboardLink = page.getByRole("link", { name: "Dashboard" });
    const dashboardLinkX = (await dashboardLink.boundingBox())?.x;

    expect(dashboardLinkX).toBeDefined();

    await languagePicker.click();
    await expect(page.getByText("Choose language", { exact: true })).toBeVisible();
    expect((await dashboardLink.boundingBox())?.x).toBe(dashboardLinkX);

    await page.keyboard.press("Escape");
    await expect(page.getByText("Choose language", { exact: true })).toBeHidden();
    expect((await dashboardLink.boundingBox())?.x).toBe(dashboardLinkX);
  });

  test("system dark mode keeps landing artwork and Clerk sign-in legible", async ({ page }) => {
    const themeScriptErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" && /script tag while rendering/i.test(message.text())) {
        themeScriptErrors.push(message.text());
      }
    });

    await page.addInitScript(() => window.localStorage.removeItem("sdp-theme"));
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");

    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.getByTestId("landing-solana-logo")).toHaveCSS("filter", "invert(1)");
    await expect(page.getByTestId("landing-hero-figure")).toHaveCSS("filter", "invert(1)");

    await page.goto("/sign-in");
    await expect(
      page.getByRole("heading", { name: "Sign in to Solana Developer Platform" })
    ).toBeVisible({ timeout: 120_000 });

    const clerkColors = await page.locator("html").evaluate((element) => {
      const styles = getComputedStyle(element);
      return {
        background: styles.getPropertyValue("--clerk-color-background").trim(),
        input: styles.getPropertyValue("--clerk-color-input").trim(),
      };
    });
    expect(clerkColors.background).not.toBe("");
    expect(clerkColors.input).not.toBe("");
    expect(clerkColors.background).not.toBe(clerkColors.input);

    await expect(page.getByLabel("Sign in with GitHub")).not.toHaveCSS("filter", "none");
    await expect(page.getByLabel("Sign in with Google")).toHaveCSS("filter", "none");
    expect(themeScriptErrors).toEqual([]);
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
