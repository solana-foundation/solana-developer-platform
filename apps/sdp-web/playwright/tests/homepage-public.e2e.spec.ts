import { expect, type Page, test } from "@playwright/test";

/** Every section of the homepage, top to bottom, by id. */
const SECTIONS = [
  "top",
  "stack",
  "pillars",
  "network",
  "issuance",
  "payments",
  "markets",
  "privacy",
  "interfaces",
  "builders",
  "walkthroughs",
  "start",
] as const;

/** Errors the page itself raises: console errors and uncaught exceptions. */
function collectPageErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** Scrolls each section into view in turn, so every lazy scene gets its chance to mount. */
async function scrollThroughSections(page: Page) {
  for (const id of SECTIONS) {
    const section = page.locator(`#${id}`);
    await section.scrollIntoViewIfNeeded();
    await expect(section).toBeVisible();
  }
}

test.describe("homepage", () => {
  test("renders every section and mounts its scenes without errors", async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.goto("/");

    await scrollThroughSections(page);

    // The globe, the three pillar scenes, the rails and the builders' ring each draw on a canvas.
    await expect(page.locator("#top canvas")).toHaveCount(1);
    await expect(page.locator("#pillars canvas")).toHaveCount(3);
    await expect(page.locator("#network canvas")).toHaveCount(1);
    await expect(page.locator("#builders canvas")).toHaveCount(1);
    await expect(page.getByRole("contentinfo")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("has one banner, one main and one contentinfo, in that order", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("banner")).toHaveCount(1);
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.getByRole("contentinfo")).toHaveCount(1);
    await expect(page.getByRole("main").locator("#top")).toHaveCount(1);
    await expect(page.getByRole("main").getByRole("banner")).toHaveCount(0);
    await expect(page.getByRole("main").getByRole("contentinfo")).toHaveCount(0);
  });

  test("never scrolls sideways on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 740 });
    await page.goto("/");

    await scrollThroughSections(page);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("closes a nav panel on Escape and hands focus back to its button", async ({ page }) => {
    await page.goto("/");
    const platform = page.getByRole("banner").getByRole("button", { name: "Platform" });

    await platform.click();
    await expect(platform).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");

    await expect(platform).toHaveAttribute("aria-expanded", "false");
    await expect(platform).toBeFocused();
  });

  test("opens the phone menu on its first link and closes it on Escape", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 740 });
    await page.goto("/");
    const burger = page.getByRole("button", { name: "Open menu" });
    // The button is labelled "Close menu" once open, so read its target first.
    const menu = page.locator(`#${await burger.getAttribute("aria-controls")}`);

    await burger.click();
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("link").first()).toBeFocused();

    // Tab wraps between the menu's last link and the bar's first control, never under the scrim.
    await menu.getByRole("link").last().focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "SDP home" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(menu.getByRole("link").last()).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(page.getByRole("button", { name: "Open menu" })).toBeFocused();
  });

  test("holds still under reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");

    await scrollThroughSections(page);

    // The builders' shot becomes one still screen, and no heading is left mid-form.
    await expect(page.locator("#builders")).toHaveAttribute("data-mode", "still");
    await expect(page.getByRole("heading", { level: 1 })).toHaveAttribute("data-form", "solid");
    const stillHidden = await page
      .locator("main [data-form]")
      .evaluateAll((headings) =>
        headings.filter((heading) => heading.getAttribute("data-form") === "hidden")
      );
    expect(stillHidden).toHaveLength(0);
  });
});
