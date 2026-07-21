import { expect, test } from "@playwright/test";
import { getPlaywrightAdminSession } from "../support/auth-session";
import { ensureLinkedOrg, ensureUnlinkedOrg } from "../support/local-dashboard-bootstrap";

test.describe
  .serial("dashboard onboarding e2e", () => {
    test.beforeAll(async ({ browser }) => {
      const session = await getPlaywrightAdminSession(browser);
      await ensureUnlinkedOrg(session.identity);
      await session.page.close();
    });

    test.afterAll(async ({ browser }) => {
      const session = await getPlaywrightAdminSession(browser);
      await ensureLinkedOrg(session.identity);
      await session.page.close();
    });

    test("a new Clerk organization enters onboarding and resumes its saved step", async ({
      page,
    }) => {
      await page.goto("/dashboard/wallets");

      await expect(
        page.getByRole("heading", { level: 1, name: "Set up your workspace" })
      ).toBeVisible({
        timeout: 120_000,
      });
      await expect(
        page.getByRole("heading", { level: 2, name: "Choose your RPC provider" })
      ).toBeVisible();

      const projectCookie = (await page.context().cookies()).find(
        (cookie) => cookie.name === "sdp_selected_project_id"
      );
      expect(projectCookie?.value).toMatch(/^prj_/);

      await page.getByRole("button", { name: /SDP RPC/ }).click();
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect(
        page.getByRole("heading", { level: 2, name: "Choose your custody provider" })
      ).toBeVisible();

      await page.reload();

      await expect(
        page.getByRole("heading", { level: 2, name: "Choose your custody provider" })
      ).toBeVisible({ timeout: 120_000 });
      const reloadedProjectCookie = (await page.context().cookies()).find(
        (cookie) => cookie.name === "sdp_selected_project_id"
      );
      expect(reloadedProjectCookie?.value).toBe(projectCookie?.value);
    });
  });
