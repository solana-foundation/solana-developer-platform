import { expect } from "@playwright/test";
import type { PaymentsDashboardWallet } from "@sdp/types/payments";
import { projectHref } from "@/lib/dashboard-project-path";
import { test } from "@/playwright/support/test";
import { createLocalApiClient } from "../support/local-api-client";
import {
  bootstrapLocalWalletFixtures,
  getBootstrapApiBaseUrl,
  gotoProjectPage,
  provisionWithAdminSession,
} from "../support/local-dashboard-bootstrap";

interface WalletsResponse {
  wallets: PaymentsDashboardWallet[];
}

const E2E_POLL_TIMEOUT_MS = 180_000;
const E2E_POLL_OPTIONS = {
  timeout: E2E_POLL_TIMEOUT_MS,
  intervals: [2_000],
};

test.describe
  .serial("dashboard wallets e2e", () => {
    test("a bootstrapped Privy wallet is listed in the overview and opens its own page", async ({
      browser,
      page,
    }) => {
      const walletLabel = `Wallet Routes ${Date.now().toString(36).toUpperCase()}`;
      const fixtures = await provisionWithAdminSession(browser, (session) =>
        bootstrapLocalWalletFixtures({
          identity: session.identity,
          bearerToken: session.getBearerToken,
          provider: "privy",
          walletCount: 1,
          walletLabel,
          tier: "enterprise",
        })
      );
      const [wallet] = fixtures.wallets;
      if (wallet === undefined) {
        throw new Error("Failed to bootstrap the wallet route fixture");
      }

      await gotoProjectPage(page, fixtures.projectId, "/dashboard/wallets");
      const walletCard = page.locator("article").filter({ hasText: walletLabel }).first();
      await expect(walletCard).toBeVisible({ timeout: E2E_POLL_TIMEOUT_MS });
      await expect(walletCard.getByText(/· Privy$/)).toBeVisible();

      await walletCard.getByRole("link", { name: `Open ${walletLabel}` }).click();
      await expect(page).toHaveURL(
        projectHref(fixtures.projectId, `/dashboard/wallets/${encodeURIComponent(wallet.walletId)}`)
      );
      await expect(page.getByRole("heading", { name: walletLabel })).toBeVisible({
        timeout: E2E_POLL_TIMEOUT_MS,
      });
    });

    test("wallet setup Enter on a choice creates nothing and Enter in the label creates once", async ({
      browser,
      page,
    }) => {
      const { bearerToken, projectId } = await provisionWithAdminSession(
        browser,
        async (session) => {
          const fixtures = await bootstrapLocalWalletFixtures({
            identity: session.identity,
            bearerToken: session.getBearerToken,
            provider: "privy",
            walletCount: 1,
            walletLabel: `Wallet Enter Prerequisite ${Date.now().toString(36).toUpperCase()}`,
            tier: "enterprise",
          });
          return {
            bearerToken: session.bearerToken,
            projectId: fixtures.projectId,
          };
        }
      );

      const api = createLocalApiClient(getBootstrapApiBaseUrl(), bearerToken, projectId);
      const walletLabel = `Wallet Enter ${Date.now().toString(36).toUpperCase()}`;
      const countMatchingWallets = async () => {
        const { wallets } = await api.get<WalletsResponse>("/v1/wallets");
        return wallets.filter((wallet) => wallet.label === walletLabel).length;
      };
      expect(await countMatchingWallets()).toBe(0);

      let serverActionRequestCount = 0;
      page.on("request", (request) => {
        if (request.method() === "POST" && request.headers()["next-action"]) {
          serverActionRequestCount += 1;
        }
      });

      // Choosing is not confirming: Enter on a provider, or on whose account, leaves the page
      // as it is.
      const choosePrivyWithEnter = async () => {
        const privyProvider = page.getByRole("radio", { name: /^Privy/ });
        await privyProvider.focus();
        await page.keyboard.press("Space");
        await expect(privyProvider).toBeChecked();
        await page.keyboard.press("Enter");
        await expect(page.getByLabel("Wallet label")).toBeVisible();
        const managedAnswer = page.getByRole("radio", { name: /^SDP's Privy account/ });
        await managedAnswer.focus();
        await page.keyboard.press("Space");
        await expect(managedAnswer).toBeChecked();
        await page.keyboard.press("Enter");
        expect(serverActionRequestCount).toBe(0);
      };

      await page.setViewportSize({ width: 390, height: 844 });
      await gotoProjectPage(page, projectId, "/dashboard/wallets/setup");
      await expect(page.getByRole("heading", { level: 2, name: "Create wallet" })).toBeVisible({
        timeout: E2E_POLL_TIMEOUT_MS,
      });
      await choosePrivyWithEnter();

      await page.setViewportSize({ width: 1280, height: 900 });
      await gotoProjectPage(page, projectId, "/dashboard/wallets/setup");
      await expect(page.getByRole("heading", { level: 2, name: "Create wallet" })).toBeVisible({
        timeout: E2E_POLL_TIMEOUT_MS,
      });
      await choosePrivyWithEnter();

      const walletLabelInput = page.getByLabel("Wallet label");
      await walletLabelInput.fill(walletLabel);
      await walletLabelInput.focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");

      // The new wallet opens on its own page.
      await expect(page).toHaveURL(new RegExp(`/dashboard/${projectId}/wallets/[^/?#]+$`), {
        timeout: E2E_POLL_TIMEOUT_MS,
      });
      expect(serverActionRequestCount).toBe(1);
      await expect.poll(countMatchingWallets, E2E_POLL_OPTIONS).toBe(1);
    });
  });
