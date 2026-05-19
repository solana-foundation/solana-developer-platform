import { expect, type Page, test } from "@playwright/test";
import type { CustodyWalletTokenBalance, Token, TokenTransaction } from "@sdp/types";
import { getPlaywrightAdminSession } from "../support/auth-session";
import { createLocalApiClient, type LocalApiClient } from "../support/local-api-client";
import {
  bootstrapLocalWalletFixtures,
  ensureLinkedOrg,
  getBootstrapApiBaseUrl,
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

interface WalletBalancesResponse {
  walletBalances: {
    balances: CustodyWalletTokenBalance[];
  };
}

interface WalletActivityEnvelope {
  data?: {
    activityRows?: Array<{
      operationLabel?: string;
      token?: string;
      amount?: string;
    }>;
  };
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

async function getWalletBalances(
  api: LocalApiClient,
  walletId: string
): Promise<CustodyWalletTokenBalance[]> {
  const response = await api.get<WalletBalancesResponse>(
    `/v1/payments/wallets/${encodeURIComponent(walletId)}/balances`
  );
  return response.walletBalances.balances;
}

async function waitForWalletTokenBalance(
  api: LocalApiClient,
  walletId: string,
  mintAddress: string,
  expectedUiAmount: number
): Promise<CustodyWalletTokenBalance> {
  let matchingBalance: CustodyWalletTokenBalance | null = null;

  await expect(async () => {
    const balances = await getWalletBalances(api, walletId);
    matchingBalance = balances.find((balance) => balance.mint === mintAddress) ?? null;

    expect(
      Number(matchingBalance?.uiAmount),
      `Expected wallet ${walletId} balance ${mintAddress} to equal ${expectedUiAmount}; current ${matchingBalance ? `uiAmount=${matchingBalance.uiAmount}, amount=${matchingBalance.amount}` : "balance missing"}`
    ).toBe(expectedUiAmount);
  }).toPass(E2E_POLL_OPTIONS);

  if (!matchingBalance) {
    throw new Error(
      `Timed out waiting for wallet ${walletId} balance ${mintAddress} to equal ${expectedUiAmount}`
    );
  }
  return matchingBalance;
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

  await api.post<TokenResponse>(
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

function expectActivityPayloadRow(
  body: WalletActivityEnvelope,
  input: { operationLabel: string; token: string; amount: string }
) {
  expect(body.data?.activityRows ?? []).toEqual(
    expect.arrayContaining([expect.objectContaining(input)])
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
    test.beforeAll(async ({ browser }) => {
      const session = await getPlaywrightAdminSession(browser);
      await ensureLinkedOrg(session.identity);
      await session.page.close();
    });

    test("user can initialize Privy and run signer check from the wallet detail page", async ({
      page,
    }) => {
      await page.goto("/dashboard/wallets");

      await expect(page.getByText("Create your first wallet", { exact: true })).toBeVisible();

      const privyCard = page.locator("article").filter({
        has: page.getByRole("heading", { name: "Privy" }),
      });
      await privyCard.getByRole("button", { name: "New wallet" }).click();

      await page.getByLabel("Primary wallet label").fill("Treasury");
      await page.getByRole("button", { name: "Create wallet" }).click();

      const walletCard = page.locator("article").filter({
        has: page.getByText("Treasury"),
      });
      await expect(walletCard).toBeVisible({ timeout: 120_000 });

      await walletCard.getByRole("link", { name: "Manage" }).click();
      await expect(page).toHaveURL(/\/dashboard\/wallets\/.+/);

      await page.getByRole("button", { name: "Actions" }).click();
      await page.getByRole("menuitem", { name: "Prove ownership" }).click();

      await expect(page.getByText("Signer check sent.")).toBeVisible({ timeout: 120_000 });
      await expect(page.getByRole("link", { name: "View on Solana Explorer" })).toBeVisible();
    });

    test("wallet activity shows real burn rows and balance after API burn flow", async ({
      browser,
      page,
    }) => {
      test.setTimeout(420_000);

      const session = await getPlaywrightAdminSession(browser);
      const fixtures = await bootstrapLocalWalletFixtures({
        identity: session.identity,
        bearerToken: session.bearerToken,
        provider: "privy",
        walletCount: 1,
        fundSourceWallet: true,
        fundSourceAmountSol: 0.05,
        tier: "enterprise",
      });
      const api = createLocalApiClient(getBootstrapApiBaseUrl(), session.bearerToken);
      await session.page.close();

      const wallet = fixtures.wallets[0];
      if (!wallet) {
        throw new Error("Failed to bootstrap wallet burn activity fixture");
      }

      const deployedToken = await createAndDeployWalletActivityToken(api, wallet.walletId);
      const mintAddress = deployedToken.mintAddress;
      if (!mintAddress) {
        throw new Error("Failed to deploy wallet activity token with a mint address");
      }

      const minted = await api.post<MintResponse>(
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

      const burned = await api.post<TransactionResponse>(
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

      const forceBurned = await api.post<TransactionResponse>(
        `/v1/issuance/tokens/${encodeURIComponent(deployedToken.id)}/force-burn`,
        {
          signingWalletId: wallet.walletId,
          forceBurn: {
            source: minted.tokenAccount,
            amount: "1",
          },
        }
      );
      expect(forceBurned.transaction.type).toBe("force_burn");
      expect(forceBurned.transaction.status).toBe("confirmed");
      expect(forceBurned.transaction.signature).toBeTruthy();

      await waitForToken(
        api,
        deployedToken.id,
        (token) => token.totalSupply === "3",
        "have total supply 3"
      );
      await waitForWalletTokenBalance(api, wallet.walletId, mintAddress, 3);

      await page.goto(`/dashboard/wallets/${wallet.walletId}`);

      const balancesSection = page.locator("section").filter({
        has: page.getByRole("heading", { name: "Balances" }),
      });
      await expect(balancesSection.getByText(`3.00 ${mintAddress}`, { exact: true })).toBeVisible({
        timeout: 120_000,
      });
      await expect(balancesSection.getByText(mintAddress, { exact: true }).first()).toBeVisible();

      const expectedActivityRows = [
        { operationLabel: "Burn", token: deployedToken.symbol, amount: "2" },
        { operationLabel: "Force Burn", token: deployedToken.symbol, amount: "1" },
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

      const refreshButton = page.getByRole("button", { name: "Refresh" });
      await expect(refreshButton).toBeEnabled();
      const activityResponsePromise = page.waitForResponse(
        (response) =>
          response.status() === 200 &&
          response
            .url()
            .includes(`/api/dashboard/wallets/${encodeURIComponent(wallet.walletId)}/activity`)
      );

      await refreshButton.click();
      const activityResponse = await activityResponsePromise;
      const activityBody = (await activityResponse.json()) as WalletActivityEnvelope;
      for (const { expectedRow } of activityRows) {
        expectActivityPayloadRow(activityBody, expectedRow);
      }

      for (const { locator } of activityRows) {
        await expect(locator).toBeVisible();
      }
    });

    test("wallet activity keeps existing rows visible when refresh fails", async ({
      browser,
      page,
    }) => {
      const session = await getPlaywrightAdminSession(browser);
      const fixtures = await bootstrapLocalWalletFixtures({
        identity: session.identity,
        bearerToken: session.bearerToken,
        provider: "privy",
        walletCount: 1,
        tier: "enterprise",
      });
      await session.page.close();

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

      await page.goto(`/dashboard/wallets/${wallet.walletId}`);
      const activityRow = page.locator("tr").filter({ hasText: "5.00 USDC" });
      await expect(activityRow).toBeVisible({ timeout: 120_000 });
      await expect(activityRow).toContainText("Incoming");
      await expect(activityRow.getByRole("link")).toHaveCount(1);

      failNextActivityRequest = true;
      await page.getByRole("button", { name: "Refresh" }).click();

      await expect(page.getByText("Activity refresh failed")).toBeVisible();
      await expect(activityRow).toBeVisible();
    });
  });
