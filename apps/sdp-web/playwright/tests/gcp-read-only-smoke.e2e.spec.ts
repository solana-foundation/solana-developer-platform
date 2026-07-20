import { expect, type Page, test } from "@playwright/test";
import type {
  ListProjectsResponse,
  PaymentsDashboardWallet,
  PaymentTransferSummary,
  Project,
  TokenTransactionListItem,
} from "@sdp/types";
import {
  formatCurrencyAmount,
  resolveTotalBalance,
} from "../../src/app/dashboard/payments/payments-overview.utils";
import { getE2EEnv } from "../env";
import { getPlaywrightAdminSession } from "../support/auth-session";
import { createLocalApiClient } from "../support/local-api-client";
import { seedProjectCookie } from "../support/local-dashboard-bootstrap";

interface ReadOnlyFixture {
  issuanceTransactions: TokenTransactionListItem[];
  project: Project;
  populatedWallet: PaymentsDashboardWallet;
  populatedWalletBalanceLabel: string;
  transferMarker: string;
  transfers: PaymentTransferSummary[];
  wallets: PaymentsDashboardWallet[];
}

interface PageFailureCapture {
  failures: string[];
  assertClean: () => void;
}

function capturePageFailures(page: Page): PageFailureCapture {
  const failures: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => failures.push(`page: ${error.message}`));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === new URL(getE2EEnv().baseURL).origin && response.status() >= 500) {
      failures.push(`${response.status()} ${url.pathname}`);
    }
  });

  return {
    failures,
    assertClean: () => expect(failures, "dashboard browser failures").toEqual([]),
  };
}

async function assertExactIdentityAndProject(page: Page, fixture: ReadOnlyFixture): Promise<void> {
  const env = getE2EEnv();
  await expect
    .poll(() =>
      page.evaluate(() => {
        return (
          window as unknown as {
            Clerk?: { organization?: { id?: string } };
          }
        ).Clerk?.organization?.id;
      })
    )
    .toBe(env.clerkOrgId);

  const projectCookie = (await page.context().cookies()).find(
    (cookie) => cookie.name === "sdp_selected_project_id"
  );
  expect(projectCookie?.value).toBe(fixture.project.id);
  await expect(page.getByText(fixture.project.name, { exact: true }).first()).toBeVisible();
}

async function proveDashboardHydrated(page: Page, projectName: string): Promise<void> {
  const switcher = page.getByRole("button").filter({ hasText: projectName }).first();
  await switcher.click();
  await expect(page.getByText("Projects", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
}

test.describe("GCP dev dashboard read-only smoke", () => {
  let fixture: ReadOnlyFixture;

  test.beforeAll(async ({ browser }) => {
    const env = getE2EEnv();
    if (!env.useExternalApi) {
      throw new Error("GCP smoke must run in explicit external mode");
    }
    expect(env.sdpApiBaseUrl).toBe("https://api-dev.solana.com");

    const session = await getPlaywrightAdminSession(browser);
    expect(session.identity.email).toBe(env.clerkTestEmail);
    expect(session.identity.organizationId).toBe(env.clerkOrgId);

    const orgApi = createLocalApiClient(env.sdpApiBaseUrl, session.getBearerToken);
    const { projects } = await orgApi.get<ListProjectsResponse>("/v1/projects");
    expect(projects.length, "the explicit test organization must have projects").toBeGreaterThan(0);

    const project = projects.find((candidate) => candidate.id === env.expectedProjectId);
    expect(project, "the exact GCP smoke project must belong to the test org").toBeDefined();
    if (!project) throw new Error("Exact GCP smoke project was not returned by the API");

    const api = createLocalApiClient(env.sdpApiBaseUrl, session.getBearerToken, project.id);
    const walletsPath = `/v1/wallets?${new URLSearchParams({
      includeBalances: "true",
      includeAllProviders: "true",
      view: "summary",
    })}`;
    const issuancePath = `/v1/issuance/transactions?${new URLSearchParams({
      page: "1",
      pageSize: "20",
    })}`;
    const transfersPath = `/v1/payments/transfers?${new URLSearchParams({
      page: "1",
      pageSize: "20",
    })}`;
    const [walletData, issuanceTransactions, transfers] = await Promise.all([
      api.get<{ wallets: PaymentsDashboardWallet[] }>(walletsPath),
      api.get<TokenTransactionListItem[]>(issuancePath),
      api.get<PaymentTransferSummary[]>(transfersPath),
    ]);
    const transferMarker = transfers[0]?.token ?? transfers[0]?.amount;
    if (!transferMarker) throw new Error("The known transfer needs a rendered token or amount");
    const populatedWallet = walletData.wallets.find(
      (wallet) => (resolveTotalBalance(wallet.balances ?? []) ?? 0) > 0
    );
    if (!populatedWallet) throw new Error("The exact test project needs a populated wallet");
    const populatedWalletBalanceLabel = formatCurrencyAmount(
      resolveTotalBalance(populatedWallet.balances ?? []),
      "en-US"
    );
    expect(populatedWalletBalanceLabel, "the known populated wallet fixture changed").toBe(
      "$10.00"
    );

    fixture = {
      issuanceTransactions,
      populatedWallet,
      populatedWalletBalanceLabel,
      project,
      transferMarker,
      transfers,
      wallets: walletData.wallets,
    };
    const knownRecordCount =
      fixture.wallets.length + fixture.issuanceTransactions.length + fixture.transfers.length;
    expect(knownRecordCount, "the exact test project must contain known records").toBeGreaterThan(
      0
    );
    expect(fixture.wallets.length, "wallet hydration needs a real wallet fixture").toBeGreaterThan(
      0
    );
    expect(
      fixture.issuanceTransactions.length,
      "home activity needs a real issuance transaction"
    ).toBeGreaterThan(0);
    expect(fixture.transfers.length, "payments needs a real transfer fixture").toBeGreaterThan(0);

    console.info(
      JSON.stringify({
        event: "gcp_read_only_fixture",
        projectId: fixture.project.id,
        projectName: fixture.project.name,
        wallets: fixture.wallets.length,
        issuanceTransactions: fixture.issuanceTransactions.length,
        transfers: fixture.transfers.length,
      })
    );
    await session.page.close();
  });

  test.beforeEach(async ({ page }) => {
    await seedProjectCookie(page, fixture.project.id);
  });

  test("home loads one combined activity request", async ({ page }) => {
    const capture = capturePageFailures(page);
    const activityRequests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/dashboard/home/activity") {
        activityRequests.push(request.url());
      }
    });
    const activityResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/dashboard/home/activity"
    );

    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    expect((await activityResponse).status()).toBe(200);
    await expect(page.getByText("Recent transactions", { exact: true })).toBeVisible();
    await expect(
      page
        .locator("tbody tr")
        .filter({ hasText: fixture.issuanceTransactions[0].token.symbol })
        .first()
    ).toBeVisible();
    await assertExactIdentityAndProject(page, fixture);
    expect(activityRequests).toHaveLength(1);
    capture.assertClean();
  });

  test("payments hydrates server data without immediate duplicate requests", async ({ page }) => {
    const capture = capturePageFailures(page);
    const hydrationRequests: string[] = [];
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (
        pathname === "/api/dashboard/wallets/aggregate" ||
        pathname === "/api/dashboard/payments/transfers"
      ) {
        hydrationRequests.push(pathname);
      }
    });

    await page.goto("/dashboard/payments", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1, name: "Payments" })).toBeVisible();
    await expect(
      page.locator("tbody tr").filter({ hasText: fixture.transferMarker }).first()
    ).toBeVisible();
    await proveDashboardHydrated(page, fixture.project.name);
    await assertExactIdentityAndProject(page, fixture);
    expect(hydrationRequests).toEqual([]);
    capture.assertClean();
  });

  test("wallets batches balance hydration into one request", async ({ page }) => {
    const capture = capturePageFailures(page);
    const batchBalanceRequests: string[] = [];
    const legacyBalanceRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      const pathname = url.pathname;
      if (
        pathname === "/api/dashboard/wallets" &&
        url.searchParams.get("includeBalances") === "true"
      ) {
        batchBalanceRequests.push(request.url());
      }
      if (/^\/api\/dashboard\/payments\/wallets\/[^/]+\/balances$/.test(pathname)) {
        legacyBalanceRequests.push(pathname);
      }
    });
    const balancesResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api/dashboard/wallets" &&
        url.searchParams.get("includeBalances") === "true"
      );
    });

    await page.goto("/dashboard/wallets", { waitUntil: "domcontentloaded" });
    expect((await balancesResponse).status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "Wallets" })).toBeVisible();
    await expect(
      page.locator("article").filter({ hasText: fixture.wallets[0].publicKey }).first()
    ).toBeVisible();
    await expect(
      page.locator("article").filter({ hasText: fixture.populatedWallet.publicKey }).first()
    ).toContainText(fixture.populatedWalletBalanceLabel);
    await proveDashboardHydrated(page, fixture.project.name);
    await assertExactIdentityAndProject(page, fixture);
    expect(batchBalanceRequests).toHaveLength(1);
    expect(legacyBalanceRequests).toEqual([]);
    capture.assertClean();
  });
});
