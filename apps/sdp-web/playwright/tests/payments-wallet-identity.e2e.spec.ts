import { expect as playwrightExpect, test } from "@playwright/test";
import { projectHref } from "@/lib/dashboard-project-path";
import { gotoProjectPage } from "../support/local-dashboard-bootstrap";
import {
  bootstrapWalletIdentityFixtures,
  cleanupWalletIdentityFixtures,
} from "../support/payments-wallet-identity";

import { setWalletIdentityRpcMode } from "../support/wallet-identity-rpc";

const TIMEOUT = 120_000;
const expect = playwrightExpect.configure({ timeout: TIMEOUT });
interface BalanceResponse {
  walletBalances: {
    custodyWalletId: string;
    walletId: string;
    balances: Array<{ token: string; amount: string; uiAmount: string }>;
  };
}

test.describe
  .serial("Payments exact wallet balance journeys", () => {
    // shortcut: Dedicated CI wiring waits for isolated DB/RPC and untouched rollback UI; opt in for release acceptance.
    test.skip(
      process.env.PLAYWRIGHT_WALLET_IDENTITY !== "1",
      "Requires isolated wallet identity release fixtures"
    );
    let fixture: Awaited<ReturnType<typeof bootstrapWalletIdentityFixtures>>;

    test.beforeAll(async ({ browser }) => {
      await setWalletIdentityRpcMode("zero");
      fixture = await bootstrapWalletIdentityFixtures(browser);
    });
    test.afterAll(async () => {
      await fixture?.admin.page.close();
      await cleanupWalletIdentityFixtures();
      await setWalletIdentityRpcMode("zero");
    });

    test("keeps alias-equivalent wallet cards and balance responses bound to their exact IDs", async ({
      page,
    }) => {
      const { api, projectId, walletA, walletB } = fixture;
      const summaryQuery = new URLSearchParams({ includeBalances: "true", view: "summary" });
      const { wallets } = await api.get<{
        wallets: Array<{ id: string; walletId: string; balances: unknown[] }>;
      }>(`/v1/wallets?${summaryQuery}`);
      for (const wallet of [walletA, walletB]) {
        expect(wallets.find((row) => row.id === wallet.id)).toMatchObject({
          id: wallet.id,
          walletId: wallet.walletId,
          balances: expect.any(Array),
        });
      }
      for (const wallet of [walletA, walletB]) {
        const { walletBalances } = await api.get<{
          walletBalances: { custodyWalletId: string; walletId: string; balances: unknown[] };
        }>(`/v1/payments/wallets/${wallet.id}/balances`);
        expect(walletBalances.custodyWalletId).toBe(wallet.id);
        expect(walletBalances.walletId).toBe(wallet.walletId);
        expect(walletBalances.balances).toEqual(expect.any(Array));
      }
      await gotoProjectPage(page, projectId, "/dashboard/wallets");
      await expect(page).toHaveURL(projectHref(projectId, "/dashboard/wallets"));
      await expect(page.getByText("Wallet Identity A", { exact: true }).first()).toBeVisible({
        timeout: TIMEOUT,
      });
      for (const wallet of [walletA, walletB]) {
        const card = page.locator(`[data-wallet-card="${wallet.id}"]`);
        await expect(card).toBeVisible({ timeout: 15_000 });
        await expect(card.getByRole("link", { name: /^(Open .+|Manage)$/ })).toHaveAttribute(
          "href",
          projectHref(projectId, `/dashboard/wallets/${wallet.id}`)
        );
      }
      await page
        .locator(`[data-wallet-card="${walletB.id}"]`)
        .getByRole("link", { name: /^(Open .+|Manage)$/ })
        .click();
      await expect(page).toHaveURL(projectHref(projectId, `/dashboard/wallets/${walletB.id}`));
      await expect(
        page.getByRole("heading", { name: "Wallet Identity B", exact: true })
      ).toBeVisible();
      await page.reload();
      await expect(page).toHaveURL(projectHref(projectId, `/dashboard/wallets/${walletB.id}`));
    });

    test("shows unavailable for a real RPC failure and recovers to confirmed zero", async ({
      page,
    }) => {
      const { api, projectId, walletA, walletB } = fixture;
      const { walletBalances } = await api.get<BalanceResponse>(
        `/v1/payments/wallets/${walletA.id}/balances`
      );
      expect(walletBalances.balances).toContainEqual(
        expect.objectContaining({ token: "SOL", amount: "0", uiAmount: "0" })
      );
      const before = await setWalletIdentityRpcMode("unavailable");
      try {
        await expect(api.get(`/v1/payments/wallets/${walletA.id}/balances`)).rejects.toThrow(
          "(503)"
        );
        await gotoProjectPage(page, projectId, "/dashboard/wallets");
        for (const wallet of [walletA, walletB]) {
          const card = page.locator(`[data-wallet-card="${wallet.id}"]`);
          await expect(card.getByText("Unavailable", { exact: true })).toBeVisible({
            timeout: TIMEOUT,
          });
          await expect(card.getByText("$0.00", { exact: true })).toHaveCount(0);
        }
        await gotoProjectPage(page, projectId, `/dashboard/wallets/${walletA.id}`);
        await expect(
          page.getByRole("heading", { name: "Wallet Identity A", exact: true })
        ).toBeVisible();
        const total = page.locator("section").filter({
          has: page.getByText(/^(Total balance|Balance)$/),
          hasNot: page.locator("section"),
        });
        await expect(total).toHaveCount(1);
        await expect(total.getByText("—", { exact: true })).toBeVisible({ timeout: TIMEOUT });
        await expect(total.getByText(/unavailable/i)).toBeVisible();
        await expect(total.getByText("$0.00", { exact: true })).toHaveCount(0);
        const after = await setWalletIdentityRpcMode("unavailable");
        expect(after.calls.getAccountInfo ?? 0).toBeGreaterThan(before.calls.getAccountInfo ?? 0);
      } finally {
        await setWalletIdentityRpcMode("zero");
      }
      await page.reload();
      const total = page.locator("section").filter({
        has: page.getByText(/^(Total balance|Balance)$/),
        hasNot: page.locator("section"),
      });
      await expect(total).toHaveCount(1);
      await expect(total.getByText("$0.00", { exact: true })).toBeVisible({ timeout: TIMEOUT });
      await expect(total.getByText(/unavailable/i)).toHaveCount(0);
      await gotoProjectPage(page, projectId, "/dashboard/wallets");
      for (const wallet of [walletA, walletB]) {
        await expect(
          page.locator(`[data-wallet-card="${wallet.id}"]`).getByText("$0.00", { exact: true })
        ).toBeVisible({ timeout: TIMEOUT });
      }
    });

    test("switches project without reusing alias balances or wallet links from another project", async ({
      page,
    }) => {
      const { api, otherApi, projectId, otherProjectId, walletA, otherWallet } = fixture;
      await expect(otherApi.get(`/v1/payments/wallets/${walletA.id}/balances`)).rejects.toThrow(
        "(404)"
      );
      await expect(api.get(`/v1/payments/wallets/${otherWallet.id}/balances`)).rejects.toThrow(
        "(404)"
      );
      await gotoProjectPage(page, projectId, "/dashboard/wallets");
      await expect(page.locator(`[data-wallet-card="${walletA.id}"]`)).toBeVisible({
        timeout: TIMEOUT,
      });
      await gotoProjectPage(page, otherProjectId, "/dashboard/wallets");
      await expect(page).toHaveURL(projectHref(otherProjectId, "/dashboard/wallets"));
      const card = page.locator(`[data-wallet-card="${otherWallet.id}"]`);
      await expect(card).toBeVisible({ timeout: TIMEOUT });
      await expect(page.locator(`[data-wallet-card="${walletA.id}"]`)).toHaveCount(0);
      await card.getByRole("link", { name: /^(Open .+|Manage)$/ }).click();
      await expect(page).toHaveURL(
        projectHref(otherProjectId, `/dashboard/wallets/${otherWallet.id}`)
      );
      await expect(
        page.getByRole("heading", { name: "Wallet Identity Other Project", exact: true })
      ).toBeVisible();
      await page.reload();
      await expect(page.getByText("$0.00", { exact: true }).first()).toBeVisible({
        timeout: TIMEOUT,
      });
      await gotoProjectPage(page, projectId, "/dashboard/wallets");
      await expect(page.locator(`[data-wallet-card="${walletA.id}"]`)).toBeVisible();
      await expect(page.locator(`[data-wallet-card="${otherWallet.id}"]`)).toHaveCount(0);
    });

    test("canonicalizes an unambiguous provider-ID bookmark to its internal wallet URL", async ({
      page,
    }) => {
      const { otherApi, otherProjectId, otherWallet } = fixture;
      const { walletBalances } = await otherApi.get<BalanceResponse>(
        `/v1/payments/wallets/${encodeURIComponent(otherWallet.walletId)}/balances`
      );
      expect(walletBalances.custodyWalletId).toBe(otherWallet.id);
      expect(walletBalances.walletId).toBe(otherWallet.walletId);
      const newDesignWallets =
        process.env.SDP_FLAG_NEW_DESIGN === "true" &&
        process.env.SDP_FLAG_NEW_DESIGN_WALLETS === "true";
      const bookmarkParams = new URLSearchParams({ label: "Wallet & Treasury" });
      bookmarkParams.append("filter", "a");
      bookmarkParams.append("filter", "b");
      if (newDesignWallets) bookmarkParams.set("tab", "settings");
      const bookmarkedQuery = `?${bookmarkParams}`;
      await gotoProjectPage(
        page,
        otherProjectId,
        `/dashboard/wallets/${encodeURIComponent(otherWallet.walletId)}${bookmarkedQuery}`
      );
      const canonicalPath = projectHref(otherProjectId, `/dashboard/wallets/${otherWallet.id}`);
      const expectCanonicalBookmark = async () => {
        await expect(page).toHaveURL(
          (url) =>
            url.pathname === canonicalPath &&
            url.searchParams.get("label") === "Wallet & Treasury" &&
            url.searchParams.get("tab") === (newDesignWallets ? "settings" : null)
        );
        const url = new URL(page.url());
        expect(url.searchParams.getAll("label")).toEqual(["Wallet & Treasury"]);
        expect(url.searchParams.getAll("tab")).toEqual(newDesignWallets ? ["settings"] : []);
        expect(url.searchParams.getAll("filter")).toEqual(["a", "b"]);
        expect(url.searchParams.size).toBe(newDesignWallets ? 4 : 3);
        expect(url.hash).toBe("");
        if (newDesignWallets) {
          await expect(page.getByRole("tab", { name: "Settings", exact: true })).toHaveAttribute(
            "aria-selected",
            "true"
          );
        }
      };
      await expectCanonicalBookmark();
      await expect(
        page.getByRole("heading", { name: "Wallet Identity Other Project", exact: true })
      ).toBeVisible();
      await page.reload();
      await expectCanonicalBookmark();
    });

    test("keeps untouched main UI compatible with the additive API during web rollback", async ({
      page,
    }) => {
      const { otherApi, otherProjectId, otherWallet } = fixture;
      const oldWebUrl = process.env.PLAYWRIGHT_OLD_WEB_URL;
      if (!oldWebUrl || !["127.0.0.1", "localhost"].includes(new URL(oldWebUrl).hostname)) {
        throw new Error(
          "Compatibility E2E requires PLAYWRIGHT_OLD_WEB_URL for a loopback untouched main UI"
        );
      }
      const { walletBalances } = await otherApi.get<BalanceResponse>(
        `/v1/payments/wallets/${encodeURIComponent(otherWallet.walletId)}/balances`
      );
      expect(walletBalances.custodyWalletId).toBe(otherWallet.id);
      expect(walletBalances.walletId).toBe(otherWallet.walletId);
      await page.goto(`${oldWebUrl}${projectHref(otherProjectId, "/dashboard/wallets")}`);
      const card = page.locator(`[data-wallet-card="${otherWallet.walletId}"]`);
      await expect(card).toBeVisible({ timeout: TIMEOUT });
      await expect(card.getByText("$0.00", { exact: true })).toBeVisible({ timeout: TIMEOUT });
      await card.getByRole("link", { name: /^(Open .+|Manage)$/ }).click();
      await expect(page).toHaveURL(
        `${oldWebUrl}${projectHref(otherProjectId, `/dashboard/wallets/${otherWallet.walletId}`)}`
      );
      await expect(
        page.getByRole("heading", { name: "Wallet Identity Other Project", exact: true })
      ).toBeVisible();
      await expect(page.getByText("$0.00", { exact: true }).first()).toBeVisible({
        timeout: TIMEOUT,
      });
    });
  });
