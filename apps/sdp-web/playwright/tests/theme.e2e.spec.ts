import { type Browser, expect, type Page, test } from "@playwright/test";
import {
  bootstrapLocalWalletFixtures,
  bootstrapProjectForPage,
} from "../support/local-dashboard-bootstrap";

const THEME_STORAGE_KEY = "sdp-theme";
const THEME_TEST_INITIALIZED_KEY = "sdp-theme-test-initialized";

type ThemePreference = "System" | "Light" | "Dark";

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

/** The account-menu trigger renders in both the desktop sidebar and the mobile
 *  More sheet, so target whichever copy the current viewport actually shows. */
function accountMenuTrigger(page: Page) {
  return page.getByRole("button", { name: "Account menu" }).filter({ visible: true });
}

async function openAccountMenu(page: Page) {
  await accountMenuTrigger(page).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
}

async function closeAccountMenu(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
}

/** One of the three icon segments on the menu's Color theme row. */
function themeSegment(page: Page, preference: ThemePreference) {
  return page.getByRole("menu").getByRole("button", { name: preference, exact: true });
}

/** The control lives in the sidebar account menu; segment clicks keep it open. */
async function setThemePreference(page: Page, preference: ThemePreference) {
  await openAccountMenu(page);
  await themeSegment(page, preference).click();
  await expect(themeSegment(page, preference)).toHaveAttribute("aria-pressed", "true");
  await closeAccountMenu(page);
}

/** Only the toast test needs a wallet to copy an address from. Bootstrapping it for the
 *  whole suite meant one custody-provider hiccup failed every theme test with it.
 *  Bootstrapping replaces the org, so the page's project cookie must be reseeded
 *  before it navigates — see seedProjectCookie. */
async function bootstrapWalletForToasts(browser: Browser, page: Page) {
  return bootstrapProjectForPage(browser, page, (session) =>
    bootstrapLocalWalletFixtures({
      identity: session.identity,
      bearerToken: session.getBearerToken,
      provider: "privy",
      walletCount: 1,
      walletLabel: `Theme Toast ${Date.now().toString(36).toUpperCase()}`,
      tier: "enterprise",
    })
  );
}

test.describe("dashboard theme e2e", () => {
  test("keeps the only theme control in the account menu, off settings and the chrome", async ({
    page,
  }) => {
    await clearThemePreferenceBeforeNavigation(page);
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();

    // Nothing theme-shaped in the page chrome until the account menu opens.
    await expect(page.getByText("Color theme")).toHaveCount(0);

    const menu = await openAccountMenu(page);
    await expect(menu.getByText("Color theme")).toBeVisible();
    for (const preference of ["System", "Light", "Dark"] as const) {
      await expect(themeSegment(page, preference)).toBeVisible();
    }
    await closeAccountMenu(page);

    // The settings card it used to live on is gone.
    await page.goto("/dashboard/settings");
    await expect(page.getByRole("group", { name: "Color theme" })).toHaveCount(0);
  });

  test("defaults to system without a stored preference, and renders no hydration errors", async ({
    page,
  }) => {
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
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();

    await openAccountMenu(page);
    await expect(themeSegment(page, "System")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("html")).toHaveClass(/dark/);
    expect(reactRenderErrors).toEqual([]);
  });

  test("persists an explicit choice across a reload", async ({ page }) => {
    await clearThemePreferenceBeforeNavigation(page);
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/dashboard");
    await setThemePreference(page, "Dark");
    await expect(page.locator("html")).toHaveClass(/dark/);

    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await openAccountMenu(page);
    await expect(themeSegment(page, "Dark")).toHaveAttribute("aria-pressed", "true");
  });

  // The defect this whole change exists to fix: the old binary switch could only ever
  // write "light" or "dark", so system was unreachable once a user touched it.
  test("lets a user hand control back to the system after an explicit override", async ({
    page,
  }) => {
    await clearThemePreferenceBeforeNavigation(page);
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/dashboard");
    await setThemePreference(page, "Dark");
    await expect(page.locator("html")).toHaveClass(/dark/);

    await setThemePreference(page, "System");
    await expect(page.locator("html")).not.toHaveClass(/dark/);

    // Back under system control, so live OS changes are followed again.
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).not.toHaveClass(/dark/);
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

    await setThemePreference(page, "Dark");
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveClass(/dark/);
  });

  test("themes rendered toasts in both modes", async ({ browser, page }) => {
    await bootstrapWalletForToasts(browser, page);
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

    await setThemePreference(page, "Dark");
    await expect(page.locator("html")).toHaveClass(/dark/);

    await page.goto("/dashboard/wallets");
    const darkCopyAddress = page.getByRole("button", { name: "Copy wallet address" }).first();
    await expect(darkCopyAddress).toBeVisible();
    await darkCopyAddress.click();
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

    const codePanel = page.locator(".code-block-line-numbers");
    const readCodeTokens = () =>
      codePanel.evaluate((element) => {
        const styles = getComputedStyle(element);
        return {
          background: styles.getPropertyValue("--code-block-bg").trim(),
          keyword: styles.getPropertyValue("--shiki-token-keyword").trim(),
        };
      });

    const openPlayground = async () => {
      await page.goto("/dashboard/payments");
      await page.getByRole("tab", { name: "API Playground" }).click();
      await expect(codePanel).toBeVisible();
    };

    await openPlayground();
    const lightTokens = await readCodeTokens();
    expect(lightTokens.background).not.toBe("");
    expect(lightTokens.keyword).not.toBe("");

    await setThemePreference(page, "Dark");
    await expect(page.locator("html")).toHaveClass(/dark/);

    await openPlayground();
    const darkTokens = await readCodeTokens();
    expect(darkTokens.background).not.toBe("");
    expect(darkTokens.keyword).not.toBe("");
    expect(darkTokens.background).not.toBe(lightTokens.background);
    expect(darkTokens.keyword).not.toBe(lightTokens.keyword);
  });

  test("synchronizes an explicit preference across open tabs", async ({ page }) => {
    await clearThemePreferenceBeforeNavigation(page);
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();

    const secondPage = await page.context().newPage();
    await secondPage.goto("/dashboard");
    await expect(secondPage.getByRole("heading", { name: "Home" })).toBeVisible();

    await setThemePreference(page, "Dark");
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(secondPage.locator("html")).toHaveClass(/dark/);

    await secondPage.close();
  });

  test("disables control transitions when reduced motion is requested", async ({ page }) => {
    await clearThemePreferenceBeforeNavigation(page);
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();

    // Assert transition-property, not duration: `transition-none` clears the property
    // list but leaves the design system's --default-transition-duration in place, so a
    // duration assertion would pass or fail for reasons unrelated to reduced motion.
    await openAccountMenu(page);
    const segment = themeSegment(page, "Dark");
    await expect(segment).toBeVisible();
    await expect(segment).toHaveCSS("transition-property", "none");

    // And prove the media query is what did it, rather than there being no transition at all.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(segment).not.toHaveCSS("transition-property", "none");
  });

  test("lays the theme control out without overflow on a narrow viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await clearThemePreferenceBeforeNavigation(page);
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();

    // Below xl the account menu lives in the bottom bar's More sheet.
    await page.getByRole("button", { name: "More" }).click();
    await openAccountMenu(page);

    // All three segments stay on one row, inside the viewport, with no horizontal scroll.
    const segmentBoxes = await page
      .getByRole("menu")
      .getByRole("button", { name: /^(System|Light|Dark)$/ })
      .evaluateAll((segments) =>
        segments.map((segment) => {
          const box = segment.getBoundingClientRect();
          return { top: box.top, right: box.right, width: box.width };
        })
      );
    expect(segmentBoxes).toHaveLength(3);
    for (const box of segmentBoxes) {
      expect(box.top).toBeCloseTo(segmentBoxes[0].top, 0);
      expect(box.width).toBeGreaterThan(0);
      expect(box.right).toBeLessThanOrEqual(390);
    }

    const documentOverflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    expect(documentOverflows).toBe(false);
  });
});
