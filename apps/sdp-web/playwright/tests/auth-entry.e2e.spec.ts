import { expect, test } from "@playwright/test";

test.describe("public auth entry e2e", () => {
  test("signed-out homepage offers self-serve signup and the docs", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const hero = page.locator("#top");
    // The drawn letters are hidden from assistive technology; the name is the sentence.
    await expect(
      hero.getByRole("heading", { level: 1, name: "The interface to onchain finance" })
    ).toBeVisible();
    await expect(hero.getByRole("link", { name: "Create account" })).toHaveAttribute(
      "href",
      "/sign-up"
    );
    await expect(hero.getByRole("link", { name: "Read the docs" })).toBeVisible();
    const header = page.getByRole("banner");
    await expect(header.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/sign-in");
    await expect(header.getByRole("link", { name: "Create account" })).toHaveAttribute(
      "href",
      "/sign-up"
    );
    await expect(header.getByRole("button", { name: "Docs" })).toBeVisible();
  });

  test("language picker does not shift the header when it opens or closes", async ({ page }) => {
    await page.goto("/");

    const languagePicker = page.getByRole("button", { name: "Language" });
    const signInLink = page.getByRole("banner").getByRole("link", { name: "Sign in" });
    const signInLinkX = (await signInLink.boundingBox())?.x;

    expect(signInLinkX).toBeDefined();

    await languagePicker.click();
    await expect(page.getByText("Choose language", { exact: true })).toBeVisible();
    expect((await signInLink.boundingBox())?.x).toBe(signInLinkX);

    await page.keyboard.press("Escape");
    await expect(page.getByText("Choose language", { exact: true })).toBeHidden();
    expect((await signInLink.boundingBox())?.x).toBe(signInLinkX);
  });

  test("system dark mode leaves the homepage light and keeps Clerk sign-in legible", async ({
    page,
  }) => {
    const themeScriptErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" && /script tag while rendering/i.test(message.text())) {
        themeScriptErrors.push(message.text());
      }
    });

    await page.addInitScript(() => window.localStorage.removeItem("sdp-theme"));
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");

    // The homepage is locked to light (FORCED_THEMES in theme-context.tsx).
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await expect(page.getByTestId("homepage-sdp-mark")).toHaveCSS("filter", "none");

    // A client-side navigation away must hand the page back to the visitor's theme.
    await page.getByRole("banner").getByRole("link", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/sign-in/);
    await expect(page.locator("html")).toHaveClass(/dark/);
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

    const githubIcon = page.locator(".cl-socialButtonsProviderIcon__github");
    const googleIcon = page.locator(".cl-socialButtonsProviderIcon__google");
    await expect(githubIcon).not.toHaveCSS("filter", "none");
    await expect(googleIcon).toHaveCSS("filter", "none");
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
