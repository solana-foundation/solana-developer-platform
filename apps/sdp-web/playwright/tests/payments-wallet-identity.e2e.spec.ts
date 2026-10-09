import { expect, type Page, test } from "@playwright/test";
import { type PaymentWalletPolicy, SOL_MINT } from "@sdp/types";
import { Client } from "pg";
import { projectHref } from "@/lib/dashboard-project-path";
import { getE2EEnv } from "../env";
import { getPlaywrightAdminSession, type PlaywrightAdminSession } from "../support/auth-session";
import { createLocalApiClient, type LocalApiClient } from "../support/local-api-client";
import {
  bootstrapLocalWalletFixtures,
  getBootstrapApiBaseUrl,
  getPlaywrightDatabaseUrl,
  gotoProjectPage,
  type PlaywrightWalletFixture,
  resolvePlaywrightProjects,
} from "../support/local-dashboard-bootstrap";

const TIMEOUT = 120_000;
const v1Key = (projectId: string, wallet: PlaywrightWalletFixture) =>
  `sdp.wallet-policy-authoring.v1.${projectId}.${wallet.walletId}`;
const v2Key = (projectId: string, wallet: PlaywrightWalletFixture) =>
  `sdp.wallet-policy-authoring.v2.${projectId}.${wallet.id}`;

function draftState(max: string) {
  return {
    defaultAction: "allow",
    categories: ["limits"],
    limits: [{ asset: SOL_MINT, max }],
    assets: [],
    destinationMode: "allowlist",
    destinationAllowText: "",
    destinationBlockText: "",
    familyActions: {},
    operationTypeRules: [],
    passthroughRules: [],
  };
}

function draft(projectId: string, wallet: PlaywrightWalletFixture, max: string, version: 1 | 2) {
  return {
    version,
    projectId,
    ...(version === 1 ? { walletId: wallet.walletId } : { custodyWalletId: wallet.id }),
    step: "limits-assets",
    state: draftState(max),
    updatedAt: new Date().toISOString(),
  };
}

async function putPolicy(api: LocalApiClient, wallet: PlaywrightWalletFixture, max: string) {
  return api.put<{ policy: PaymentWalletPolicy }>(
    `/v1/payments/wallets/${encodeURIComponent(wallet.id)}/policies`,
    {
      defaultAction: "allow",
      rules: [
        { id: "per-transaction-limit", kind: "amount", max, assets: [SOL_MINT], action: "allow" },
      ],
    }
  );
}

async function getPolicy(api: LocalApiClient, wallet: PlaywrightWalletFixture) {
  const result = await api.get<{ policy: PaymentWalletPolicy }>(
    `/v1/payments/wallets/${encodeURIComponent(wallet.id)}/policies`
  );
  expect(result.policy.custodyWalletId).toBe(wallet.id);
  return result.policy;
}

async function openLimits(page: Page, projectId: string, wallet: PlaywrightWalletFixture) {
  await gotoProjectPage(page, projectId, `/dashboard/wallets/${wallet.id}/policy`);
  const amount = page.getByLabel("Per transaction SOL", { exact: true });
  await expect(
    amount.or(page.getByRole("combobox", { name: "Default decision", exact: true }))
  ).toBeVisible({ timeout: TIMEOUT });
  if (!(await amount.isVisible())) {
    await page.getByRole("button", { name: "Continue", exact: true }).click();
  }
  await expect(amount).toBeVisible({ timeout: TIMEOUT });
  return amount;
}

async function review(page: Page, message: string) {
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Activate controls", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Review changes" })).toBeVisible();
  await page.getByLabel("Commit message (optional)").fill(message);
}

async function confirm(page: Page, wallet: PlaywrightWalletFixture) {
  const response = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().endsWith(`/api/dashboard/payments/wallets/${wallet.id}/policies`)
  );
  await page
    .getByRole("dialog", { name: "Review changes" })
    .getByRole("button", { name: "Activate controls", exact: true })
    .click();
  return response;
}

test.describe
  .serial("Payments exact wallet policy journeys", () => {
    let admin: PlaywrightAdminSession;
    let api: LocalApiClient;
    let projectId: string;
    let otherProjectId: string;
    let otherProjectApi: LocalApiClient;
    let wallets: PlaywrightWalletFixture[];
    let otherProjectWallet: PlaywrightWalletFixture;

    test.beforeAll(async ({ browser }) => {
      expect(getE2EEnv().useExternalApi, "Mutating policy E2E requires the local API").toBe(false);
      admin = await getPlaywrightAdminSession(browser);
      const fixtures = await bootstrapLocalWalletFixtures({
        identity: admin.identity,
        bearerToken: admin.getBearerToken,
        provider: "local",
        walletCount: 1,
        walletLabel: "Policy Identity A",
        tier: "enterprise",
      });
      projectId = fixtures.projectId;
      wallets = fixtures.wallets;
      api = createLocalApiClient(getBootstrapApiBaseUrl(), admin.getBearerToken, projectId);
      // Both standard projects belong only to the isolated local test API.
      // This suite writes policies, never funds/signs/sends chain transactions.
      const databaseUrl = getPlaywrightDatabaseUrl();
      if (!["localhost", "127.0.0.1"].includes(new URL(databaseUrl).hostname)) {
        throw new Error("Wallet identity E2E requires an isolated loopback DATABASE_URL");
      }
      const db = new Client({ connectionString: databaseUrl });
      await db.connect();
      otherProjectId = (
        await resolvePlaywrightProjects(getBootstrapApiBaseUrl(), admin.getBearerToken)
      ).production;
      const orgWalletId = `cwlt_${crypto.randomUUID()}`;
      try {
        // Reuse the real encrypted local key in a valid retained org Config:
        // current setup requires project scope, but org Configs remain supported.
        // Both records must pass the real operational/API resolver below.
        const orgConfigId = `cust_cfg_${crypto.randomUUID()}`;
        await db.query("BEGIN");
        await db.query(
          `INSERT INTO custody_configs (id, organization_id, project_id, provider,
             config_encrypted, encryption_version, default_wallet_id, status)
           SELECT $1, c.organization_id, NULL, c.provider, c.config_encrypted,
                  c.encryption_version, c.default_wallet_id, c.status
           FROM custody_configs c JOIN custody_wallets w ON w.custody_config_id = c.id
           WHERE w.id = $2`,
          [orgConfigId, wallets[0].id]
        );
        await db.query(
          `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, label, purpose, status)
           SELECT $1, $2, wallet_id, public_key, 'Policy Identity Org Wallet', purpose, status
           FROM custody_wallets WHERE id = $3`,
          [orgWalletId, orgConfigId, wallets[0].id]
        );
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      } finally {
        await db.end();
      }
      const listed = await api.get<{ wallets: PlaywrightWalletFixture[] }>(
        // biome-ignore lint/security/noSecrets: Public wallet-list path, not a credential.
        "/v1/wallets?includeAllProviders=true"
      );
      const orgWallet = listed.wallets.find((wallet) => wallet.id === orgWalletId);
      if (!orgWallet) throw new Error("Organization-scoped fixture is not operational");
      expect(orgWallet.walletId).toBe(wallets[0].walletId);
      expect(orgWallet.publicKey).toBe(wallets[0].publicKey);
      wallets.push(orgWallet);
      otherProjectApi = createLocalApiClient(
        getBootstrapApiBaseUrl(),
        admin.getBearerToken,
        otherProjectId
      );
      const initialized = await otherProjectApi.post<{ walletId: string }>(
        "/v1/wallets/initialize",
        {
          provider: "local",
          walletLabel: "Policy Identity Other Project",
        }
      );
      const otherWallets = await otherProjectApi.get<{ wallets: PlaywrightWalletFixture[] }>(
        // biome-ignore lint/security/noSecrets: Public wallet-list path, not a credential.
        "/v1/wallets?includeAllProviders=true"
      );
      const otherWallet = otherWallets.wallets.find(
        (wallet) => wallet.walletId === initialized.walletId
      );
      if (!otherWallet) throw new Error("Other local project wallet is not operational");
      otherProjectWallet = otherWallet;
      await putPolicy(otherProjectApi, otherProjectWallet, "85");
    });

    test.afterAll(async () => {
      await admin?.page.close();
    });
    test.beforeEach(async () => {
      await putPolicy(api, wallets[0], "25");
      await putPolicy(api, wallets[1], "75");
    });

    test("navigates exact wallets, reads balances, commits and reloads only the intended policy", async ({
      page,
    }) => {
      const [wallet, other] = wallets;
      const balances = await api.get<{
        walletBalances: { custodyWalletId: string; balances: unknown[] };
      }>(`/v1/payments/wallets/${wallet.id}/balances`);
      expect(balances.walletBalances.custodyWalletId).toBe(wallet.id);
      expect(Array.isArray(balances.walletBalances.balances)).toBe(true);
      await gotoProjectPage(page, projectId, "/dashboard/wallets");
      const card = page.locator(`[data-wallet-card="${wallet.id}"]`);
      await card.getByRole("link", { name: "Manage" }).click();
      await expect(page).toHaveURL(projectHref(projectId, `/dashboard/wallets/${wallet.id}`));
      await expect(
        page.getByRole("heading", { name: wallet.label ?? "Policy Identity A" })
      ).toBeVisible();
      const amount = await openLimits(page, projectId, wallet);
      await expect(amount).toHaveValue("25");
      await amount.fill("26");
      await review(page, "Exact wallet policy browser commit");
      expect((await confirm(page, wallet)).ok()).toBe(true);
      await expect(page.getByText("Wallet controls active.", { exact: true })).toBeVisible();
      expect((await getPolicy(api, wallet)).rules).toContainEqual(
        expect.objectContaining({ kind: "amount", max: "26" })
      );
      expect((await getPolicy(api, other)).rules).toContainEqual(
        expect.objectContaining({ kind: "amount", max: "75" })
      );
      await page.reload();
      await page.getByRole("button", { name: "Revision history", exact: true }).click();
      await expect(
        page.getByText("Exact wallet policy browser commit", { exact: true }).first()
      ).toBeVisible({ timeout: TIMEOUT });
      const history = await api.get<{
        revisions: Array<{ commitMessage: string | null; rules: unknown[] }>;
      }>(`/v1/payments/wallets/${wallet.id}/policies/revisions`);
      expect(history.revisions[0].commitMessage).toBe("Exact wallet policy browser commit");
      await gotoProjectPage(page, projectId, `/dashboard/wallets/${wallet.id}/policy/audit`);
      await expect(
        page.getByRole("button", { name: "Revision history", exact: true })
      ).toBeVisible();
      await gotoProjectPage(
        page,
        otherProjectId,
        `/dashboard/wallets/${otherProjectWallet.walletId}`
      );
      await expect(page).toHaveURL(
        projectHref(otherProjectId, `/dashboard/wallets/${otherProjectWallet.id}`)
      );
    });

    test("restores legacy edits unsent, prefers the new draft and resets wallet/project state", async ({
      page,
    }) => {
      const [wallet, other] = wallets;
      await gotoProjectPage(page, projectId, "/dashboard/wallets");
      let writes = 0;
      page.on("request", (request) => {
        if (request.method() === "PUT" && request.url().includes("/policies")) writes++;
      });
      await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
        key: v1Key(projectId, wallet),
        value: draft(projectId, wallet, "33", 1),
      });
      await expect(await openLimits(page, projectId, wallet)).toHaveValue("33");
      await expect
        .poll(() =>
          page.evaluate(
            (key) => JSON.parse(localStorage.getItem(key) ?? "null")?.draft?.custodyWalletId,
            `${v2Key(projectId, wallet)}.legacy`
          )
        )
        .toBe(wallet.id);
      await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
        key: v2Key(projectId, wallet),
        value: draft(projectId, wallet, "44", 2),
      });
      await page.reload();
      await expect(page.getByLabel("Per transaction SOL", { exact: true })).toHaveValue("44");
      await expect(await openLimits(page, projectId, other)).toHaveValue("75");
      await expect(await openLimits(page, otherProjectId, otherProjectWallet)).toHaveValue("85");
      await expect(await openLimits(page, projectId, wallet)).toHaveValue("44");
      expect(writes).toBe(0);
      expect((await getPolicy(api, wallet)).rules).toContainEqual(
        expect.objectContaining({ max: "25" })
      );
    });

    test("does not resurrect a consumed legacy draft from an old tab", async ({
      page,
      context,
    }) => {
      const wallet = wallets[0];
      await gotoProjectPage(page, projectId, "/dashboard/wallets");
      const legacy = { key: v1Key(projectId, wallet), value: draft(projectId, wallet, "35", 1) };
      await page.evaluate(
        ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
        legacy
      );
      const amount = await openLimits(page, projectId, wallet);
      const oldTab = await context.newPage();
      await expect(await openLimits(oldTab, projectId, wallet)).toHaveValue("35");
      await amount.fill("36");
      await review(page, "Consume restored draft");
      expect((await confirm(page, wallet)).ok()).toBe(true);
      await expect(page.getByText("Wallet controls active.", { exact: true })).toBeVisible();
      await oldTab.evaluate(
        ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
        legacy
      );
      await oldTab.close();
      await expect(await openLimits(page, projectId, wallet)).toHaveValue("36");
    });

    test("retains edits on a refused commit and reports a successful commit despite cleanup failure", async ({
      page,
    }) => {
      const wallet = wallets[0];
      const amount = await openLimits(page, projectId, wallet);
      await amount.fill("28");
      await review(page, "Retry after a refused commit");
      const policyUrl = `**/api/dashboard/payments/wallets/${wallet.id}/policies`;
      await page.route(policyUrl, async (route) => {
        if (route.request().method() === "PUT") {
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: { message: "Controlled commit failure" } }),
          });
        } else await route.continue();
      });
      expect((await confirm(page, wallet)).status()).toBe(503);
      await expect(page.getByText("Activation failed.", { exact: true })).toBeVisible();
      expect((await getPolicy(api, wallet)).rules).toContainEqual(
        expect.objectContaining({ max: "25" })
      );
      await expect(page.getByRole("dialog", { name: "Review changes" })).toBeVisible();
      await page.unroute(policyUrl);
      await page.evaluate(() => {
        const remove = Storage.prototype.removeItem;
        Storage.prototype.removeItem = function (key) {
          if (key.startsWith("sdp.wallet-policy-authoring."))
            throw new DOMException("Controlled cleanup failure", "SecurityError");
          return remove.call(this, key);
        };
      });
      expect((await confirm(page, wallet)).ok()).toBe(true);
      await expect(page.getByText("Wallet controls active.", { exact: true })).toBeVisible();
      await expect(
        page.getByText("Policy saved. Browser draft cleanup is incomplete.", { exact: true })
      ).toBeVisible();
      await expect(page.getByRole("dialog", { name: "Review changes" })).toBeHidden();
      expect((await getPolicy(api, wallet)).rules).toContainEqual(
        expect.objectContaining({ max: "28" })
      );
    });

    test("shows unavailable client balance reads when batch and exact fallback fail", async ({
      page,
    }) => {
      const wallet = wallets[0];
      await page.route("**/api/dashboard/wallets?*", async (route) => {
        if (new URL(route.request().url()).searchParams.get("includeBalances") === "true") {
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: { message: "Controlled balance batch failure" } }),
          });
        } else await route.continue();
      });
      const requestedWallets: string[] = [];
      await page.route("**/api/dashboard/payments/wallets/*/balances", async (route) => {
        requestedWallets.push(new URL(route.request().url()).pathname.split("/").at(-2) ?? "");
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: "Controlled exact balance failure" } }),
        });
      });
      await gotoProjectPage(page, projectId, "/dashboard/wallets");
      await expect(
        page.locator(`[data-wallet-card="${wallet.id}"]`).getByText("Unavailable", { exact: true })
      ).toBeVisible({ timeout: TIMEOUT });
      expect(requestedWallets).toContain(wallet.id);
      expect(requestedWallets).not.toContain(wallet.walletId);
    });
  });
