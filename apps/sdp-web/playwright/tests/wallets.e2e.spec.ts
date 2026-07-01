import { expect, type Page, test } from "@playwright/test";
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
      await page.route(/\/api\/dashboard\/wallets\/[^/]+\/activity$/, async (route) => {
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

      await page.goto(`/dashboard/wallets/${wallet.walletId}`, { waitUntil: "domcontentloaded" });
      const activityRow = page.locator("tr").filter({ hasText: "5.00 USDC" });
      await expect(activityRow).toBeVisible({ timeout: 120_000 });
      await expect(activityRow).toContainText("Incoming");
      await expect(activityRow.getByRole("link")).toHaveCount(1);

      failNextActivityRequest = true;
      const refreshButton = page.getByRole("button", { name: "Refresh" });
      await expect(refreshButton).toBeEnabled({ timeout: E2E_POLL_TIMEOUT_MS });
      await refreshButton.click();

      await expect(page.getByText("Activity refresh failed")).toBeVisible();
      await expect(activityRow).toBeVisible();
    });
  });
