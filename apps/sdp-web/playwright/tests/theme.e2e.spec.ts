import { expect, type Page, test } from "@playwright/test";

const THEME_STORAGE_KEY = "sdp-theme";
const THEME_TEST_INITIALIZED_KEY = "sdp-theme-test-initialized";

async function clearThemePreferenceBeforeNavigation(page: Page) {
  await page.addInitScript(
    ({ initializedKey, storageKey }) => {
      if (window.sessionStorage.getItem(initializedKey) === "true") return;
      window.localStorage.removeItem(storageKey);
      window.sessionStorage.setItem(initializedKey, "true");
    },
    { initializedKey: THEME_TEST_INITIALIZED_KEY, storageKey: THEME_STORAGE_KEY }
  );
}

test.describe("dashboard theme e2e", () => {
  test("persists one accessible theme control without React render errors", async ({ page }) => {
    const reactRenderErrors: string[] = [];
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        /hydration|did not match|script tag while rendering/i.test(message.text())
      ) {
        reactRenderErrors.push(message.text());
      }
    });

    await clearThemePreferenceBeforeNavigation(page);
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();

    const themeSwitch = page.getByRole("switch", { name: "Color theme" });
    await expect(themeSwitch).toHaveCount(1);
    await expect(themeSwitch).toHaveAttribute("aria-checked", "false");

    await themeSwitch.click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(themeSwitch).toHaveAttribute("aria-checked", "true");

    await page.reload();
    await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.getByRole("switch", { name: "Color theme" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    expect(reactRenderErrors).toEqual([]);
  });

  test("themes rendered toasts in both modes", async ({ page }) => {
    await clearThemePreferenceBeforeNavigation(page);
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/dashboard/wallets");

    const copyAddress = page.getByRole("button", { name: "Copy wallet address" }).first();
    await expect(copyAddress).toBeVisible();
    await copyAddress.click();
    await expect(page.locator("[data-sonner-toaster]")).toHaveAttribute(
      "data-sonner-theme",
      "light"
    );

    await page.getByRole("switch", { name: "Color theme" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await copyAddress.click();
    await expect(page.locator("[data-sonner-toaster]")).toHaveAttribute(
      "data-sonner-theme",
      "dark"
    );
  });

  test("inherits API playground code tokens from the design system in both modes", async ({
    page,
  }) => {
    await clearThemePreferenceBeforeNavigation(page);
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/dashboard/payments");
    await page.getByRole("tab", { name: "API Playground" }).click();

    const codePanel = page.locator(".code-block-line-numbers");
    await expect(codePanel).toBeVisible();

    const readCodeTokens = () =>
      codePanel.evaluate((element) => {
        const styles = getComputedStyle(element);
        return {
          background: styles.getPropertyValue("--code-block-bg").trim(),
          keyword: styles.getPropertyValue("--shiki-token-keyword").trim(),
        };
      });

    const lightTokens = await readCodeTokens();
    expect(lightTokens.background).not.toBe("");
    expect(lightTokens.keyword).not.toBe("");

    await page.getByRole("switch", { name: "Color theme" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);

    const darkTokens = await readCodeTokens();
    expect(darkTokens.background).not.toBe("");
    expect(darkTokens.keyword).not.toBe("");
    expect(darkTokens.background).not.toBe(lightTokens.background);
    expect(darkTokens.keyword).not.toBe(lightTokens.keyword);
  });

  test("follows live system changes until the user makes an explicit choice", async ({ page }) => {
    await clearThemePreferenceBeforeNavigation(page);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.locator("body")).toHaveCSS("color-scheme", "dark");

    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await expect(page.locator("body")).toHaveCSS("color-scheme", "light");

    await page.getByRole("switch", { name: "Color theme" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveClass(/dark/);
  });

  test("synchronizes an explicit preference across open tabs", async ({ page }) => {
    await clearThemePreferenceBeforeNavigation(page);
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();

    const secondPage = await page.context().newPage();
    await secondPage.goto("/dashboard");
    await expect(secondPage.getByRole("heading", { name: "Home" })).toBeVisible();

    await page.getByRole("switch", { name: "Color theme" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(secondPage.locator("html")).toHaveClass(/dark/);
    await expect(secondPage.getByRole("switch", { name: "Color theme" })).toHaveAttribute(
      "aria-checked",
      "true"
    );

    await secondPage.close();
  });

  test("disables switch transitions when reduced motion is requested", async ({ page }) => {
    await clearThemePreferenceBeforeNavigation(page);
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();

    const themeSwitch = page.getByRole("switch", { name: "Color theme" });
    await expect(themeSwitch).toHaveCSS("transition-duration", "0s");
    await expect(themeSwitch.locator("span")).toHaveCSS("transition-duration", "0s");
  });

  test("keeps a single mobile control clear of dashboard actions", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await clearThemePreferenceBeforeNavigation(page);
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();

    const themeSwitch = page.getByRole("switch", { name: "Color theme" });
    const firstAction = page.getByRole("link", { name: "Create API key" });
    await expect(themeSwitch).toHaveCount(1);
    await expect(firstAction).toBeVisible();

    const themeBounds = await themeSwitch.boundingBox();
    const actionBounds = await firstAction.boundingBox();
    expect(themeBounds).not.toBeNull();
    expect(actionBounds).not.toBeNull();
    expect((themeBounds?.y ?? 0) + (themeBounds?.height ?? 0)).toBeLessThan(actionBounds?.y ?? 0);

    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(page.getByRole("button", { name: "Close navigation", exact: true })).toBeVisible();
    await expect(page.getByRole("switch", { name: "Color theme" })).toHaveCount(1);
  });
});
