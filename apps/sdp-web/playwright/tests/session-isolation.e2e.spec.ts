import { randomUUID } from "node:crypto";
import { createClerkClient } from "@clerk/backend";
import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { expect, type Page, test } from "@playwright/test";
import { Client } from "pg";
import { projectHref } from "@/lib/dashboard-project-path";
import { getE2EEnv } from "@/playwright/env";
import { resolveClerkTestIdentity } from "@/playwright/support/clerk-admin";
import { provisionLinkedOrgProjects } from "@/playwright/support/local-dashboard-bootstrap";

declare global {
  interface Window {
    restoreSessionIsolationActivation?: () => void;
  }
}

const env = getE2EEnv();
const clerkAdmin = createClerkClient({ secretKey: env.clerkSecretKey });
const contactA = "Session isolation contact A";
const contactB = "Session isolation contact B";
const secondName = `Session isolation ${randomUUID().slice(0, 8)}`;
let primaryName: string;
let primaryProject: string;
let primaryOrgId: string;
let productionProject: string;
let secondProject: string;
let secondOrgId: string;
let secondLocalOrg: string;
const contactIds = [`cp_${randomUUID()}`, `cp_${randomUUID()}`];

async function expectContacts(page: Page, projectId: string, own: string, other: string) {
  await page.goto(projectHref(projectId, "/dashboard/payments/counterparty"));
  await expect(page.getByRole("row", { name: new RegExp(own) })).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(other) })).toHaveCount(0);
}

async function switchOrganization(page: Page, from: string, to: string, projectId: string) {
  await page.getByRole("button", { name: from, exact: true }).click();
  await page.getByRole("menuitem", { name: new RegExp(to) }).click();
  await expect(page).toHaveURL(new RegExp(`/dashboard/${projectId}(?:[/?]|$)`));
  await expect(page.getByRole("button", { name: to, exact: true })).toBeVisible();
}

async function signOut(page: Page) {
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in(?:[/?]|$)/);
  await expect(page.locator("[data-sdp-dashboard-shell]")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Sign in to Solana Developer Platform" })
  ).toBeVisible();
}

test.describe
  .serial("dashboard session isolation", () => {
    test.describe.configure({ retries: 0 });
    test.beforeAll(async ({ browser }) => {
      if (env.useExternalApi || !process.env.DATABASE_URL) {
        throw new Error("Session isolation fixtures require an explicit local DATABASE_URL");
      }
      const databaseHost = new URL(process.env.DATABASE_URL).hostname;
      if (!["localhost", "127.0.0.1"].includes(databaseHost)) {
        throw new Error("Session isolation fixtures only write to a local database");
      }
      const projects = await provisionLinkedOrgProjects(browser);
      primaryProject = projects.sandbox;
      productionProject = projects.production;
      const identity = await resolveClerkTestIdentity();
      primaryOrgId = identity.organizationId;
      primaryName = (
        await clerkAdmin.organizations.getOrganization({ organizationId: identity.organizationId })
      ).name;
      const second = await clerkAdmin.organizations.createOrganization({
        name: secondName,
        createdBy: identity.userId,
      });
      secondOrgId = second.id;
      const db = new Client({ connectionString: process.env.DATABASE_URL });
      await db.connect();
      try {
        await db.query("BEGIN");
        secondLocalOrg = `org_session_${randomUUID()}`;
        secondProject = `prj_${randomUUID()}`;
        await db.query(
          `INSERT INTO organizations (id, name, slug, tier, status, settings, onboarding_completed_at, onboarding_version)
         SELECT $1, $2, $3, tier, status, settings, onboarding_completed_at, onboarding_version
         FROM organizations WHERE id = (SELECT organization_id FROM projects WHERE id = $4)`,
          [secondLocalOrg, secondName, `session-${randomUUID()}`, primaryProject]
        );
        await db.query(
          `INSERT INTO auth_organization_identities (id, provider, provider_org_id, organization_id)
         VALUES ($1, 'clerk', $2, $3)`,
          [`aoi_${randomUUID()}`, secondOrgId, secondLocalOrg]
        );
        await db.query(
          `INSERT INTO organization_members (id, organization_id, user_id, role, status)
         SELECT $1, $2, user_id, role, status FROM organization_members
         WHERE organization_id = (SELECT organization_id FROM projects WHERE id = $3)`,
          [`mem_${randomUUID()}`, secondLocalOrg, primaryProject]
        );
        await db.query(
          `INSERT INTO projects (id, organization_id, name, slug, description, environment, status, created_by)
         SELECT $1, $2, 'Second organization sandbox', slug, description, environment, status, created_by
         FROM projects WHERE id = $3`,
          [secondProject, secondLocalOrg, primaryProject]
        );
        await db.query(
          `INSERT INTO project_members (id, project_id, user_id)
         SELECT 'pm_' || gen_random_uuid(), $1, user_id FROM project_members WHERE project_id = $2`,
          [secondProject, primaryProject]
        );
        for (const [project, name, id] of [
          [primaryProject, contactA, contactIds[0]],
          [secondProject, contactB, contactIds[1]],
        ]) {
          await db.query(
            `INSERT INTO counterparties (id, organization_id, project_id, entity_type, display_name, provider_data, status)
           SELECT $3, organization_id, id, 'individual', $2, '{}', 'active' FROM projects WHERE id = $1`,
            [project, name, id]
          );
        }
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      } finally {
        await db.end();
      }
      await clerkSetup({ publishableKey: env.clerkPublishableKey, secretKey: env.clerkSecretKey });
    });

    test.afterAll(async () => {
      try {
        if (secondLocalOrg) {
          const db = new Client({ connectionString: process.env.DATABASE_URL });
          await db.connect();
          try {
            await db.query("BEGIN");
            await db.query("DELETE FROM counterparties WHERE id = ANY($1::text[])", [contactIds]);
            // The fixture's organization owns its projects, memberships and auth mapping.
            await db.query("DELETE FROM organizations WHERE id = $1", [secondLocalOrg]);
            await db.query("COMMIT");
          } catch (error) {
            await db.query("ROLLBACK");
            throw error;
          } finally {
            await db.end();
          }
        }
      } finally {
        if (secondOrgId) await clerkAdmin.organizations.deleteOrganization(secondOrgId);
      }
    });

    test("fresh browser sign-in opens the right organization and project", async ({
      browser,
    }, testInfo) => {
      const context = await browser.newContext({
        baseURL: env.baseURL,
        storageState: { cookies: [], origins: [] },
      });
      try {
        const page = await context.newPage();
        await page.goto(`${env.baseURL}/sign-in`);
        await clerk.signIn({ page, emailAddress: env.clerkTestEmail });
        await page.goto(`${env.baseURL}/dashboard`);
        await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
        await expectContacts(page, primaryProject, contactA, contactB);
        await testInfo.attach("signed-in-dashboard", {
          body: await page.screenshot({ path: testInfo.outputPath("browser.png") }),
          contentType: "image/png",
        });
      } finally {
        await context.close();
      }
    });

    test("organization switch in both directions isolates rows and discards unsaved forms", async ({
      page,
    }, testInfo) => {
      await expectContacts(page, primaryProject, contactA, contactB);
      const staleFrames: string[] = [];
      page.on("console", (message) => {
        if (message.text().startsWith("stale-session-frame:")) staleFrames.push(message.text());
      });
      const observeFrames = ({
        firstOrg,
        secondOrg,
        firstContact,
        secondContact,
      }: {
        firstOrg: string;
        secondOrg: string;
        firstContact: string;
        secondContact: string;
      }) => {
        const check = () => {
          const client = window.Clerk;
          const content = document.querySelector("[data-sdp-dashboard-shell]")?.textContent;
          if (content && client) {
            if (
              (client.organization?.id === firstOrg && content.includes(secondContact)) ||
              (client.organization?.id === secondOrg && content.includes(firstContact))
            ) {
              console.error("stale-session-frame:wrong-organization");
            }
          }
          requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      };
      const frameScope = {
        firstOrg: primaryOrgId,
        secondOrg: secondOrgId,
        firstContact: contactA,
        secondContact: contactB,
      };
      await page.addInitScript(observeFrames, frameScope);
      await page.evaluate(observeFrames, frameScope);
      await switchOrganization(page, primaryName, secondName, secondProject);
      await expectContacts(page, secondProject, contactB, contactA);
      await switchOrganization(page, secondName, primaryName, primaryProject);
      await expectContacts(page, primaryProject, contactA, contactB);

      await page.goto(projectHref(primaryProject, "/dashboard/api-keys/new"));
      await page.getByLabel("Name", { exact: true }).fill("Unsaved organization A secret form");
      await switchOrganization(page, primaryName, secondName, secondProject);
      await expect(page.getByLabel("Name", { exact: true })).toHaveCount(0);
      await switchOrganization(page, secondName, primaryName, primaryProject);
      await page.goto(projectHref(primaryProject, "/dashboard/api-keys/new"));
      await expect(page.getByLabel("Name", { exact: true })).toHaveValue("");
      await expect(page.getByRole("button", { name: primaryName, exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
      expect(staleFrames).toEqual([]);
      await testInfo.attach("switched-back-clean-form", {
        body: await page.screenshot({ path: testInfo.outputPath("browser.png") }),
        contentType: "image/png",
      });
    });

    test("project switching keeps Sandbox contacts out of Production", async ({ page }) => {
      await expectContacts(page, primaryProject, contactA, contactB);
      await page.getByRole("button", { name: primaryName, exact: true }).click();
      await page.getByRole("menuitem", { name: "Default Production Project", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/dashboard/${productionProject}/payments`));
      await expect(page.getByRole("row", { name: new RegExp(contactA) })).toHaveCount(0);
      await page.getByRole("button", { name: primaryName, exact: true }).click();
      await page.getByRole("menuitem", { name: "Default Sandbox Project", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/dashboard/${primaryProject}/payments`));
      await expectContacts(page, primaryProject, contactA, contactB);
    });

    test("a refused org switch keeps the current workspace usable and shows an error", async ({
      page,
    }) => {
      await expectContacts(page, primaryProject, contactA, contactB);
      await page.evaluate(() => {
        const client = window.Clerk;
        const original = client.setActive;
        window.restoreSessionIsolationActivation = () => {
          client.setActive = original;
          delete window.restoreSessionIsolationActivation;
        };
        client.setActive = async () => {
          throw new Error("Simulated activation failure");
        };
      });
      try {
        await page.getByRole("button", { name: primaryName, exact: true }).click();
        await page.getByRole("menuitem", { name: new RegExp(secondName) }).click();
        await expect(page.getByText("Could not switch organizations. Try again.")).toBeVisible();
        await expect(page.getByRole("row", { name: new RegExp(contactA) })).toBeVisible();
        await expect(page.getByRole("button", { name: primaryName, exact: true })).toHaveAttribute(
          "aria-busy",
          "false"
        );
      } finally {
        await page.evaluate(() => window.restoreSessionIsolationActivation?.());
      }
    });

    test("logout clears snapshots in both tabs and Back cannot restore private pages", async ({
      page,
    }, testInfo) => {
      await expectContacts(page, primaryProject, contactA, contactB);
      const otherTab = await page.context().newPage();
      await expectContacts(otherTab, primaryProject, contactA, contactB);
      for (const tab of [page, otherTab]) {
        await tab.evaluate(() => {
          localStorage.setItem("sdp.dashboard.cache.logout-fixture", "private organization data");
          sessionStorage.setItem("sdp.dashboard.cache.logout-fixture", "private organization data");
        });
      }
      await signOut(page);
      expect(
        (await page.context().cookies()).find((cookie) => cookie.name === "sdp_selected_project_id")
      ).toBeUndefined();
      for (const tab of [page, otherTab]) {
        await expect
          .poll(() =>
            tab.evaluate(() => ({
              local: localStorage.getItem("sdp.dashboard.cache.logout-fixture"),
              session: sessionStorage.getItem("sdp.dashboard.cache.logout-fixture"),
            }))
          )
          .toEqual({ local: null, session: null });
        await expect
          .poll(() =>
            tab.evaluate(() =>
              [localStorage, sessionStorage].flatMap((storage) =>
                Object.keys(storage).filter((key) => key.startsWith("sdp.dashboard.cache."))
              )
            )
          )
          .toEqual([]);
        await expect(tab.locator("[data-sdp-dashboard-shell]")).toHaveCount(0);
      }
      await page.goBack();
      await expect(page.locator("[data-sdp-dashboard-shell]")).toHaveCount(0);
      await expect(page.getByRole("row", { name: new RegExp(contactA) })).toHaveCount(0);
      await page.goto(projectHref(primaryProject, "/dashboard/payments/counterparty"));
      await expect(page).toHaveURL(/\/sign-in(?:[/?]|$)/);
      await expect(
        page.getByRole("heading", { name: "Sign in to Solana Developer Platform" })
      ).toBeVisible();
      await testInfo.attach("logged-out-after-back", {
        body: await page.screenshot({ path: testInfo.outputPath("browser.png") }),
        contentType: "image/png",
      });
      await otherTab.close();
    });

    test("signing back in after logout reads the current organization data", async ({
      page,
    }, testInfo) => {
      await page.goto("/sign-in");
      await clerk.signIn({ page, emailAddress: env.clerkTestEmail });
      await page.goto("/dashboard");
      await expectContacts(page, primaryProject, contactA, contactB);
      await expect
        .poll(() => page.evaluate(() => localStorage.getItem("sdp.dashboard.cache.logout-fixture")))
        .toBeNull();
      await testInfo.attach("signed-back-in", {
        body: await page.screenshot({ path: testInfo.outputPath("browser.png") }),
        contentType: "image/png",
      });
    });
  });
