import { expect, test } from "@playwright/test";
import { projectHref } from "@/lib/dashboard-project-path";
import {
  type PlaywrightProjects,
  provisionLinkedOrgProjects,
} from "../support/local-dashboard-bootstrap";

test.describe
  .serial("dashboard Project URL scope", () => {
    let projects: PlaywrightProjects;

    test.beforeAll(async ({ browser }) => {
      projects = await provisionLinkedOrgProjects(browser);
    });

    test("a key created in a Sandbox tab lands in Sandbox while another tab is on Production", async ({
      page,
    }) => {
      const keyName = `Playwright Project Scope Key ${Date.now()}`;
      await page.goto(projectHref(projects.sandbox, "/dashboard/api-keys"));
      const productionTab = await page.context().newPage();
      await productionTab.goto(projectHref(projects.production, "/dashboard/api-keys"));
      await expect(productionTab.getByText("No API keys found.")).toBeVisible();

      await page.getByRole("link", { name: "Create key" }).click();
      await page.getByLabel("Name", { exact: true }).fill(keyName);
      await page.getByRole("checkbox", { name: "Read on Transfers" }).check();
      await page.getByRole("button", { name: "Create key" }).click();
      await expect(page.locator("[data-api-key-secret]")).toBeVisible({ timeout: 120_000 });
      await expect(page).toHaveURL(new RegExp(`/dashboard/${projects.sandbox}/api-keys/`));
      await page.getByRole("button", { name: "I have saved this key" }).click();

      await page.goto(projectHref(projects.sandbox, "/dashboard/api-keys"));
      await expect(page.getByRole("row", { name: keyName })).toBeVisible({ timeout: 120_000 });
      await productionTab.reload();
      await expect(productionTab.getByText("No API keys found.")).toBeVisible();
      await expect(productionTab.getByRole("row", { name: keyName })).toHaveCount(0);
    });

    test("bare /dashboard lands on the last-used Project", async ({ page }) => {
      for (const projectId of [projects.production, projects.sandbox]) {
        await page.goto(projectHref(projectId, "/dashboard/api-keys"));
        await page.goto("/dashboard");
        await expect(page).toHaveURL(projectHref(projectId, "/dashboard"));
      }
    });

    test("an unlisted Project id redirects to Sandbox and keeps the sub-path", async ({ page }) => {
      await page.goto(projectHref(projects.production, "/dashboard"));
      await page.goto(projectHref("prj_test_unlisted", "/dashboard/api-keys"));
      await expect(page).toHaveURL(projectHref(projects.sandbox, "/dashboard/api-keys"));
    });

    // Only the Project's own 404 has this way back; the root one leaves for bare /dashboard.
    test("an address no route matches keeps the Project's shell", async ({ page }) => {
      await page.goto(projectHref(projects.sandbox, "/dashboard/no-such-page"));
      await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Back to Overview" })).toHaveAttribute(
        "href",
        projectHref(projects.sandbox, "/dashboard")
      );
    });
  });
