import { type Browser, expect, type Page, test } from "@playwright/test";
import type { Token, TokenTransaction } from "@sdp/types";
import { getPlaywrightAdminSession } from "../support/auth-session";
import { createLocalApiClient, type LocalApiClient } from "../support/local-api-client";
import {
  bootstrapLocalWalletFixtures,
  ensureLinkedOrg,
  getBootstrapApiBaseUrl,
  resolvePlaywrightProjectId,
  seedProjectCookie,
} from "../support/local-dashboard-bootstrap";

interface TokenResponse {
  token: Token;
}

interface MintResponse {
  transaction: TokenTransaction;
  tokenAccount: string;
}

interface TransactionResponse {
  transaction: TokenTransaction;
}

const E2E_POLL_TIMEOUT_MS = 180_000;
const E2E_POLL_INTERVAL_MS = 2_000;
const E2E_POLL_OPTIONS = {
  timeout: E2E_POLL_TIMEOUT_MS,
  intervals: [E2E_POLL_INTERVAL_MS],
};

async function getToken(api: LocalApiClient, tokenId: string): Promise<Token> {
  const response = await api.get<TokenResponse>(
    `/v1/issuance/tokens/${encodeURIComponent(tokenId)}`
  );
  return response.token;
}

function formatTokenState(token: Token): string {
  return `status=${token.status}, totalSupply=${token.totalSupply}, mintAddress=${token.mintAddress ?? "null"}`;
}

async function waitForToken(
  api: LocalApiClient,
  tokenId: string,
  predicate: (token: Token) => boolean,
  description: string
): Promise<Token> {
  let matchingToken: Token | null = null;

  await expect(async () => {
    const token = await getToken(api, tokenId);
    matchingToken = token;

    expect(
      predicate(token),
      `Expected token ${tokenId} to ${description}; current ${formatTokenState(token)}`
    ).toBe(true);
  }).toPass(E2E_POLL_OPTIONS);

  if (!matchingToken) {
    throw new Error(`Timed out waiting for token ${tokenId} to ${description}`);
  }
  return matchingToken;
}

async function postWithSigningProviderRetry<T>(
  api: LocalApiClient,
  path: string,
  body: unknown
): Promise<T> {
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await api.post<T>(path, body);
    } catch (error) {
      const isRetryable =
        error instanceof Error &&
        error.message.includes("signing provider is temporarily unavailable");
      if (!isRetryable || attempt === maxAttempts) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }

  throw new Error(`Signing provider request did not complete for ${path}`);
}

async function createAndDeployWalletActivityToken(
  api: LocalApiClient,
  signingWalletId: string
): Promise<Token> {
  const suffix = Date.now().toString(36).slice(-6).toUpperCase();
  const created = await api.post<TokenResponse>("/v1/issuance/tokens", {
    name: `E2E Wallet Burn ${suffix}`,
    symbol: `WB${suffix}`,
    template: "stablecoin",
    decimals: 6,
    uri: `https://example.com/metadata/e2e-wallet-burn-${suffix.toLowerCase()}.json`,
    imageUrl: "https://example.com/assets/e2e-wallet-burn.png",
    description: "Wallet activity burn coverage token",
    signingWalletId,
    requiresAllowlist: false,
    isMintable: true,
    isFreezable: true,
  });

  await postWithSigningProviderRetry<TokenResponse>(
    api,
    `/v1/issuance/tokens/${encodeURIComponent(created.token.id)}/deploy`,
    {
      signingWalletId,
    }
  );

  return waitForToken(
    api,
    created.token.id,
    (token) => token.status === "active" && Boolean(token.mintAddress),
    "be deployed"
  );
}

function getActivityRow(
  page: Page,
  input: { operationLabel: string; token: string; amount: string }
) {
  return page
    .locator("tr")
    .filter({ hasText: `${Number(input.amount).toFixed(2)} ${input.token}` })
    .filter({ hasText: input.operationLabel });
}

async function bootstrapWalletRouteFixture(
  browser: Browser,
  input: { labelPrefix: string; withPolicy?: boolean }
) {
  const session = await getPlaywrightAdminSession(browser);

  try {
    const walletLabel = `${input.labelPrefix} ${Date.now().toString(36).toUpperCase()}`;
    const fixtures = await bootstrapLocalWalletFixtures({
      identity: session.identity,
      bearerToken: session.getBearerToken,
      provider: "privy",
      walletCount: 1,
      walletLabel,
      tier: "enterprise",
    });
    const projectId = await resolvePlaywrightProjectId(
      getBootstrapApiBaseUrl(),
      session.getBearerToken
    );
    const wallet = fixtures.wallets[0];
    if (!wallet) {
      throw new Error("Failed to bootstrap wallet route fixture");
    }

    if (input.withPolicy) {
      const api = createLocalApiClient(getBootstrapApiBaseUrl(), session.getBearerToken, projectId);
      await api.put(`/v1/payments/wallets/${encodeURIComponent(wallet.walletId)}/policies`, {
        destinationAllowlist: [],
        maxTransferAmount: "25",
      });
    }

    return { projectId, wallet, walletLabel };
  } finally {
    await session.page.close();
  }
}

test.describe
  .serial("dashboard wallets e2e", () => {
    let walletsProjectId = "";

    test.beforeAll(async ({ browser }) => {
      const session = await getPlaywrightAdminSession(browser);
      await ensureLinkedOrg(session.identity);
      walletsProjectId = await resolvePlaywrightProjectId(
        getBootstrapApiBaseUrl(),
        session.getBearerToken
      );
      await session.page.close();
    });

    test.beforeEach(async ({ page }) => {
      await seedProjectCookie(page, walletsProjectId);
    });

    test("bootstrapped Privy wallet appears in the wallets overview", async ({ browser, page }) => {
      const session = await getPlaywrightAdminSession(browser);
      const walletLabel = `Wallet Detail ${Date.now().toString(36).toUpperCase()}`;
      const fixtures = await bootstrapLocalWalletFixtures({
        identity: session.identity,
        bearerToken: session.getBearerToken,
        provider: "privy",
        walletCount: 1,
        walletLabel,
        tier: "enterprise",
      });
      const projectId = await resolvePlaywrightProjectId(
        getBootstrapApiBaseUrl(),
        session.getBearerToken
      );
      await session.page.close();
      await seedProjectCookie(page, projectId);

      const wallet = fixtures.wallets[0];
      if (!wallet) {
        throw new Error("Failed to bootstrap wallet detail fixture");
      }

      await page.goto("/dashboard/wallets", { waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(/\/dashboard\/wallets(?:\?.*)?$/);

      const walletCard = page.locator("article").filter({ hasText: walletLabel }).first();
      await expect(walletCard).toBeVisible({
        timeout: 120_000,
      });
      await expect(walletCard.getByText("Privy", { exact: true })).toBeVisible();
      await expect(walletCard.getByRole("link", { name: "Manage" })).toBeVisible();
    });

    test("wallet workspace and detail aliases preserve navigation", async ({ browser, page }) => {
      const { projectId, wallet, walletLabel } = await bootstrapWalletRouteFixture(browser, {
        labelPrefix: "Wallet Routes",
      });
      await seedProjectCookie(page, projectId);

      const encodedWalletId = encodeURIComponent(wallet.walletId);
      const walletHref = `/dashboard/wallets/${encodedWalletId}`;
      const custodyHref = `/dashboard/custody/${encodedWalletId}`;

      await page.goto("/dashboard/wallets", { waitUntil: "domcontentloaded" });
      await expect(page.locator("[data-wallet-panel]").first()).toHaveAttribute(
        "data-wallet-panel",
        "overview",
        {
          timeout: E2E_POLL_TIMEOUT_MS,
        }
      );
      await page.evaluate(() => {
        const root = document.querySelector("[data-wallet-root]");
        if (!root) {
          throw new Error("Wallet workspace root did not render");
        }

        const state = { sawBlankPanel: false };
        const sample = () => {
          if (!root.querySelector("[data-wallet-panel]")) {
            state.sawBlankPanel = true;
          }
        };
        const observer = new MutationObserver(sample);
        observer.observe(root, { childList: true, subtree: true });
        Object.assign(window, { __walletWorkspacePanelMonitor: { observer, state } });
      });

      await page.getByRole("tab", { name: /API playground/i }).click();
      await expect(page.locator("[data-wallet-panel]").first()).toHaveAttribute(
        "data-wallet-panel",
        "playground-ready",
        { timeout: E2E_POLL_TIMEOUT_MS }
      );
      const sawBlankPlaygroundPanel = await page.evaluate(() => {
        const monitor = (
          window as unknown as {
            __walletWorkspacePanelMonitor?: {
              observer: MutationObserver;
              state: { sawBlankPanel: boolean };
            };
          }
        ).__walletWorkspacePanelMonitor;
        monitor?.observer.disconnect();
        return monitor?.state.sawBlankPanel ?? true;
      });
      expect(sawBlankPlaygroundPanel).toBe(false);

      await page.getByRole("tab", { name: "Overview" }).click();
      await expect(page.locator("[data-wallet-panel]").first()).toHaveAttribute(
        "data-wallet-panel",
        "overview"
      );
      const walletCard = page.locator("article").filter({ hasText: walletLabel }).first();
      await walletCard.getByRole("link", { name: "Manage" }).click();
      await expect(page).toHaveURL(new RegExp(`${walletHref.replaceAll("/", "\\/")}$`));
      await expect(page.getByRole("heading", { name: walletLabel })).toBeVisible({
        timeout: E2E_POLL_TIMEOUT_MS,
      });

      await page.goto(custodyHref, { waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(new RegExp(`${custodyHref.replaceAll("/", "\\/")}$`));
      await expect(page.getByRole("heading", { name: walletLabel })).toBeVisible({
        timeout: E2E_POLL_TIMEOUT_MS,
      });
    });

    test("wallet policy history routes preserve navigation", async ({ browser, page }) => {
      const { projectId, wallet } = await bootstrapWalletRouteFixture(browser, {
        labelPrefix: "Wallet Policy Routes",
        withPolicy: true,
      });
      await seedProjectCookie(page, projectId);

      const walletHref = `/dashboard/wallets/${encodeURIComponent(wallet.walletId)}`;
      const policyHref = `${walletHref}/policy`;
      const auditHref = `${policyHref}/audit`;
      const revisionsHref = `${policyHref}/revisions`;

      await page.goto(policyHref, { waitUntil: "domcontentloaded" });
      await expect(page.locator(`a[href="${auditHref}"]`)).toBeVisible({
        timeout: E2E_POLL_TIMEOUT_MS,
      });
      await expect(page.locator(`a[href="${revisionsHref}"]`)).toBeVisible({
        timeout: E2E_POLL_TIMEOUT_MS,
      });

      await page.locator(`a[href="${auditHref}"]`).click();
      await expect(page).toHaveURL(new RegExp(`${auditHref.replaceAll("/", "\\/")}$`));
      await expect(page.locator(`a[href="${revisionsHref}"]`)).toBeVisible({
        timeout: E2E_POLL_TIMEOUT_MS,
      });

      await page.locator(`a[href="${revisionsHref}"]`).click();
      await expect(page).toHaveURL(new RegExp(`${revisionsHref.replaceAll("/", "\\/")}$`));
      await expect(page.locator(`a[href="${auditHref}"]`)).toBeVisible({
        timeout: E2E_POLL_TIMEOUT_MS,
      });
    });

    test("wallet setup routes preserve provider selection and aliases", async ({
      browser,
      page,
    }, testInfo) => {
      const session = await getPlaywrightAdminSession(browser);
      const projectId = await resolvePlaywrightProjectId(
        getBootstrapApiBaseUrl(),
        session.getBearerToken
      );
      await ensureLinkedOrg(session.identity, { tier: "enterprise" });
      await session.page.close();
      await seedProjectCookie(page, projectId);

      await page.goto("/dashboard/wallets/setup", { waitUntil: "domcontentloaded" });
      await expect(page.getByText("Step 1 of 2", { exact: true })).toBeVisible({
        timeout: E2E_POLL_TIMEOUT_MS,
      });
      const setupActions = page.locator("[data-wallet-setup-actions]");
      const setupScrollRegion = page.locator("[data-wallet-setup-scroll-region]");
      const cancelButton = page.getByRole("button", { name: "Cancel" });
      const nextButton = page.getByRole("button", { name: "Next", exact: true });
      await expect(setupActions).toBeVisible();
      await expect(cancelButton).toBeVisible();
      await expect(nextButton).toBeDisabled();

      const desktopScreenshotPath = testInfo.outputPath("wallet-create-desktop.png");
      await page.screenshot({ path: desktopScreenshotPath });
      await testInfo.attach("wallet-create-desktop", {
        path: desktopScreenshotPath,
        contentType: "image/png",
      });

      const desktopActionsBox = await setupActions.boundingBox();
      const desktopScrollBox = await setupScrollRegion.boundingBox();
      expect(desktopActionsBox).not.toBeNull();
      expect(desktopScrollBox).not.toBeNull();
      expect((desktopScrollBox?.y ?? 0) + (desktopScrollBox?.height ?? 0)).toBeLessThanOrEqual(
        (desktopActionsBox?.y ?? 0) + 1
      );

      await setupScrollRegion.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const scrolledActionsBox = await setupActions.boundingBox();
      expect(scrolledActionsBox?.y).toBe(desktopActionsBox?.y);

      const privyProvider = page.getByRole("button", { name: /Privy/ });
      await privyProvider.focus();
      await page.keyboard.press("Space");
      await expect(privyProvider).toHaveAttribute("aria-pressed", "true");
      await expect(nextButton).toBeEnabled();
      await nextButton.click();
      await expect(page.getByText("Step 2 of 2", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Wallet label")).toBeVisible();

      const detailsScreenshotPath = testInfo.outputPath("wallet-create-details-desktop.png");
      await page.screenshot({ path: detailsScreenshotPath });
      await testInfo.attach("wallet-create-details-desktop", {
        path: detailsScreenshotPath,
        contentType: "image/png",
      });

      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect(page.getByText("Step 1 of 2", { exact: true })).toBeVisible();
      await expect(privyProvider).toHaveAttribute("aria-pressed", "true");
      await cancelButton.click();
      await expect(page).toHaveURL(/\/dashboard\/wallets$/);

      await page.goto("/dashboard/wallets/setup?provider=privy", {
        waitUntil: "domcontentloaded",
      });
      await expect(page.getByLabel("Wallet label")).toBeVisible({
        timeout: E2E_POLL_TIMEOUT_MS,
      });

      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("/dashboard/wallets/setup", { waitUntil: "domcontentloaded" });
      await expect(page.getByText("Step 1 of 2", { exact: true })).toBeVisible({
        timeout: E2E_POLL_TIMEOUT_MS,
      });
      await expect(setupActions).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
        )
      ).toBe(true);

      const mobileTopScreenshotPath = testInfo.outputPath("wallet-create-mobile-top.png");
      await page.screenshot({ path: mobileTopScreenshotPath });
      await testInfo.attach("wallet-create-mobile-top", {
        path: mobileTopScreenshotPath,
        contentType: "image/png",
      });

      const mobileActionsBeforeScroll = await setupActions.boundingBox();
      await setupScrollRegion.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const mobileActionsAfterScroll = await setupActions.boundingBox();
      expect(mobileActionsAfterScroll?.y).toBe(mobileActionsBeforeScroll?.y);
      const lastProvider = setupScrollRegion.getByRole("button").last();
      await expect(lastProvider).toBeVisible();
      const mobileScrollBox = await setupScrollRegion.boundingBox();
      const lastProviderBox = await lastProvider.boundingBox();
      expect((lastProviderBox?.y ?? 0) + (lastProviderBox?.height ?? 0)).toBeLessThanOrEqual(
        (mobileScrollBox?.y ?? 0) + (mobileScrollBox?.height ?? 0) + 1
      );

      const mobileScreenshotPath = testInfo.outputPath("wallet-create-mobile.png");
      await page.screenshot({ path: mobileScreenshotPath });
      await testInfo.attach("wallet-create-mobile", {
        path: mobileScreenshotPath,
        contentType: "image/png",
      });

      for (const switchHref of ["/dashboard/wallets/switch", "/dashboard/custody/switch"]) {
        await page.goto(switchHref, { waitUntil: "domcontentloaded" });
        await expect(page).toHaveURL(/\/dashboard\/wallets\/setup$/);
        await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible({
          timeout: E2E_POLL_TIMEOUT_MS,
        });
      }
    });

    // ponytail: quarantined until Surfpool signing stops intermittently hanging in CI.
    test.skip("wallet activity shows a real burn row after API burn flow", async ({
      browser,
      page,
    }) => {
      test.setTimeout(420_000);

      const session = await getPlaywrightAdminSession(browser);
      const fixtures = await bootstrapLocalWalletFixtures({
        identity: session.identity,
        bearerToken: session.getBearerToken,
        provider: "privy",
        walletCount: 1,
        tier: "enterprise",
      });
      const projectId = await resolvePlaywrightProjectId(
        getBootstrapApiBaseUrl(),
        session.getBearerToken
      );
      const api = createLocalApiClient(getBootstrapApiBaseUrl(), session.getBearerToken, projectId);
      await seedProjectCookie(page, projectId);

      const wallet = fixtures.wallets[0];
      if (!wallet) {
        throw new Error("Failed to bootstrap wallet burn activity fixture");
      }

      const deployedToken = await createAndDeployWalletActivityToken(api, wallet.walletId);
      const mintAddress = deployedToken.mintAddress;
      if (!mintAddress) {
        throw new Error("Failed to deploy wallet activity token with a mint address");
      }

      const minted = await postWithSigningProviderRetry<MintResponse>(
        api,
        `/v1/issuance/tokens/${encodeURIComponent(deployedToken.id)}/mint`,
        {
          signingWalletId: wallet.walletId,
          mint: {
            destination: wallet.publicKey,
            amount: "6",
          },
        }
      );
      expect(minted.transaction.status).toBe("confirmed");
      expect(minted.tokenAccount).toBeTruthy();

      const burned = await postWithSigningProviderRetry<TransactionResponse>(
        api,
        `/v1/issuance/tokens/${encodeURIComponent(deployedToken.id)}/burn`,
        {
          signingWalletId: wallet.walletId,
          burn: {
            source: minted.tokenAccount,
            amount: "2",
          },
        }
      );
      expect(burned.transaction.type).toBe("burn");
      expect(burned.transaction.status).toBe("confirmed");
      expect(burned.transaction.signature).toBeTruthy();

      await waitForToken(
        api,
        deployedToken.id,
        (token) => token.totalSupply === "4",
        "have total supply 4"
      );
      await session.page.close();

      await page.goto(`/dashboard/wallets/${wallet.walletId}`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "Recent activity" }).scrollIntoViewIfNeeded();

      const expectedActivityRows = [
        { operationLabel: "Burn", token: deployedToken.symbol, amount: "2" },
      ];
      const activityRows = expectedActivityRows.map((expectedRow) => ({
        expectedRow,
        locator: getActivityRow(page, expectedRow),
      }));

      for (const { locator } of activityRows) {
        await expect(locator).toBeVisible({ timeout: 120_000 });
        await expect(locator.getByText("confirmed", { exact: true })).toBeVisible();
        await expect(locator.getByRole("link")).toHaveCount(1);
      }
    });

    test("wallet activity keeps existing rows visible when refresh fails", async ({
      browser,
      page,
    }) => {
      test.setTimeout(420_000);

      const session = await getPlaywrightAdminSession(browser);
      const fixtures = await bootstrapLocalWalletFixtures({
        identity: session.identity,
        bearerToken: session.getBearerToken,
        provider: "privy",
        walletCount: 1,
        tier: "enterprise",
      });
      const projectId = await resolvePlaywrightProjectId(
        getBootstrapApiBaseUrl(),
        session.getBearerToken
      );
      await session.page.close();
      await seedProjectCookie(page, projectId);

      const wallet = fixtures.wallets[0];
      if (!wallet) {
        throw new Error("Failed to bootstrap wallet activity fixture");
      }

      let failNextActivityRequest = false;
      let activityRequestCount = 0;
      await page.route(/\/api\/dashboard\/wallets\/[^/]+\/activity$/, async (route) => {
        activityRequestCount += 1;
        if (failNextActivityRequest) {
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              error: { message: "Activity refresh failed" },
            }),
          });
          return;
        }

        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              activityRows: [
                {
                  id: "payment-e2e-refresh",
                  sourceKind: "payments",
                  operationLabel: "Incoming",
                  status: "confirmed",
                  signature: "payment_signature_e2e_111111111111111111111111111111111",
                  token: "USDC",
                  amount: "5",
                  address: wallet.publicKey,
                  createdAt: "2024-01-02T00:00:00.000Z",
                  updatedAt: "2024-01-02T00:00:00.000Z",
                },
              ],
              activityError: null,
              activityNotice: null,
            },
          }),
        });
      });

      await page.setViewportSize({ width: 1280, height: 500 });
      await page.goto(`/dashboard/wallets/${wallet.walletId}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: wallet.label ?? "Treasury" })).toBeVisible({
        timeout: E2E_POLL_TIMEOUT_MS,
      });
      await expect(page.getByRole("button", { name: "Actions" })).toBeEnabled();
      const activityRegion = page.locator("[data-wallet-activity-state]");
      await expect(activityRegion).not.toBeInViewport();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          })
      );
      await expect(activityRegion).toHaveAttribute("data-wallet-activity-state", "deferred");
      expect(activityRequestCount).toBe(0);

      await page.getByRole("heading", { name: "Recent activity" }).scrollIntoViewIfNeeded();
      await expect(activityRegion).toHaveAttribute("data-wallet-activity-state", "mounted");
      await expect.poll(() => activityRequestCount).toBe(1);

      const activityRow = page.locator("tr").filter({ hasText: "5.00 USDC" });
      await expect(activityRow).toBeVisible({ timeout: 120_000 });
      await expect(activityRow).toContainText("Incoming");
      await expect(activityRow.getByRole("link")).toHaveCount(1);

      await page
        .getByRole("heading", { name: wallet.label ?? "Treasury" })
        .scrollIntoViewIfNeeded();
      await expect(activityRegion).not.toBeInViewport();
      await expect(activityRegion).toHaveAttribute("data-wallet-activity-visible", "false");
      const requestCountBeforeReconnect = activityRequestCount;
      await page.evaluate(() => {
        window.dispatchEvent(new Event("offline"));
        window.dispatchEvent(new Event("online"));
      });
      await page.waitForTimeout(1_000);
      expect(activityRequestCount).toBe(requestCountBeforeReconnect);

      await page.getByRole("heading", { name: "Recent activity" }).scrollIntoViewIfNeeded();
      await expect(activityRegion).toHaveAttribute("data-wallet-activity-visible", "true");
      await expect.poll(() => activityRequestCount).toBe(requestCountBeforeReconnect + 1);

      failNextActivityRequest = true;
      const refreshButton = page.getByRole("button", { name: "Refresh" });
      await expect(refreshButton).toBeEnabled({ timeout: E2E_POLL_TIMEOUT_MS });
      await refreshButton.click();

      await expect(page.getByText("Activity refresh failed")).toBeVisible();
      await expect(activityRow).toBeVisible();
    });
  });
