import { expect, test } from "@playwright/test";
import { gotoProjectPage, provisionLinkedOrgProjects } from "../support/local-dashboard-bootstrap";

test.describe("dashboard first paint", () => {
  let projectId = "";

  test.beforeAll(async ({ browser }) => {
    const projects = await provisionLinkedOrgProjects(browser);
    projectId = projects.sandbox;
  });

  test("the server-rendered document carries the page, not the loading skeleton", async ({
    page,
  }) => {
    for (const dashboardPath of ["/dashboard", "/dashboard/payments", "/dashboard/api-keys"]) {
      const response = await gotoProjectPage(page, projectId, dashboardPath);
      if (response === null) {
        throw new Error(`Expected a document response for ${dashboardPath}`);
      }
      const html = await response.text();
      expect(html).toContain("data-dashboard-page-content");
      expect(html).not.toContain("data-shell-loading-skeleton");
    }
  });
});
