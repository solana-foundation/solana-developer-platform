import { expect as playwrightExpect, test } from "@playwright/test";
import {
  formatCurrencyAmount,
  formatDisplayAmount,
  isSolBalance,
  resolveTotalBalance,
} from "@/app/dashboard/[projectId]/payments/payments-overview.utils";
import { projectHref } from "@/lib/dashboard-project-path";
import { parseWalletBalanceResponse } from "@/lib/wallet-balance-response";
import { gotoProjectPage } from "../support/local-dashboard-bootstrap";
import { bootstrapWalletIdentityFixtures } from "../support/payments-wallet-identity";

const TIMEOUT = 120_000;
const expect = playwrightExpect.configure({ timeout: TIMEOUT });

test.describe
  .serial("Payments exact wallet balance journeys", () => {
    let fixture: Awaited<ReturnType<typeof bootstrapWalletIdentityFixtures>>;

    test.beforeAll(async ({ browser }) => {
      fixture = await bootstrapWalletIdentityFixtures(browser);
    });
    test.afterAll(async () => {
      await fixture?.cleanup();
    });

    test("keeps alias-equivalent wallet cards and balance responses bound to their exact IDs", async ({
      page,
    }) => {
      const { api, projectId, walletA, walletB } = fixture;
      const snapshots: Array<ReturnType<typeof parseWalletBalanceResponse>> = [];
      for (const wallet of [walletA, walletB]) {
        const walletBalances = parseWalletBalanceResponse(
          {
            data: await api.get<unknown>(
              `/v1/payments/wallets/${encodeURIComponent(wallet.id)}/balances`
            ),
          },
          wallet.id
        );
        expect(walletBalances.walletId).toBe(wallet.walletId);
        expect(walletBalances.address).toBe(wallet.publicKey);
        snapshots.push(walletBalances);
      }
      await gotoProjectPage(page, projectId, "/dashboard/wallets");
      await expect(page).toHaveURL(projectHref(projectId, "/dashboard/wallets"));
      await expect(page.getByText("Wallet Identity A", { exact: true }).first()).toBeVisible({
        timeout: TIMEOUT,
      });
      for (const snapshot of snapshots) {
        const card = page.locator(`[data-wallet-card="${snapshot.custodyWalletId}"]`);
        await expect(card).toBeVisible({ timeout: 15_000 });
        await expect(card.getByRole("link", { name: /^(Open .+|Manage)$/ })).toHaveAttribute(
          "href",
          projectHref(projectId, `/dashboard/wallets/${snapshot.custodyWalletId}`)
        );
        await expect(
          card.getByText(formatCurrencyAmount(resolveTotalBalance(snapshot.balances), "en"), {
            exact: true,
          })
        ).toBeVisible();
      }
      const walletBSnapshot = snapshots.find((snapshot) => snapshot.custodyWalletId === walletB.id);
      const solBalance = walletBSnapshot?.balances.find(isSolBalance);
      if (!walletBSnapshot || !solBalance) {
        throw new Error("Wallet Identity B balance response did not include native SOL");
      }
      const expectedTotal = formatCurrencyAmount(
        resolveTotalBalance(walletBSnapshot.balances),
        "en"
      );
      const expectDetailBalances = async () => {
        const legacyTotal = page
          .locator("section")
          .filter({ has: page.getByText("Total balance", { exact: true }) })
          .getByText(expectedTotal, { exact: true });
        await expect(page.locator("[data-wallet-balance]").or(legacyTotal)).toHaveText(
          expectedTotal
        );
        await expect(page.getByText(solBalance.token, { exact: true })).toBeVisible();
        await expect(
          page.getByText(formatDisplayAmount(solBalance.uiAmount, solBalance.token, "en"), {
            exact: true,
          })
        ).toBeVisible();
      };
      await page
        .locator(`[data-wallet-card="${walletB.id}"]`)
        .getByRole("link", { name: /^(Open .+|Manage)$/ })
        .click();
      await expect(page).toHaveURL(projectHref(projectId, `/dashboard/wallets/${walletB.id}`));
      await expect(
        page.getByRole("heading", { name: "Wallet Identity B", exact: true })
      ).toBeVisible();
      await expectDetailBalances();
      await page.reload();
      await expect(page).toHaveURL(projectHref(projectId, `/dashboard/wallets/${walletB.id}`));
      await expect(
        page.getByRole("heading", { name: "Wallet Identity B", exact: true })
      ).toBeVisible();
      await expectDetailBalances();
    });

    test("keeps wallet selection and links scoped when switching projects", async ({ page }) => {
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
      await expect(page).toHaveURL(
        projectHref(otherProjectId, `/dashboard/wallets/${otherWallet.id}`)
      );
      await expect(
        page.getByRole("heading", { name: "Wallet Identity Other Project", exact: true })
      ).toBeVisible();
      await gotoProjectPage(page, projectId, "/dashboard/wallets");
      await expect(page.locator(`[data-wallet-card="${walletA.id}"]`)).toBeVisible();
      await expect(page.locator(`[data-wallet-card="${otherWallet.id}"]`)).toHaveCount(0);
    });

    test("canonicalizes an unambiguous provider-ID bookmark to its internal wallet URL", async ({
      page,
    }) => {
      const { api, projectId, bookmarkWallet } = fixture;
      const walletBalances = parseWalletBalanceResponse(
        {
          data: await api.get<unknown>(
            `/v1/payments/wallets/${encodeURIComponent(bookmarkWallet.walletId)}/balances`
          ),
        },
        bookmarkWallet.id
      );
      expect(walletBalances.custodyWalletId).toBe(bookmarkWallet.id);
      expect(walletBalances.walletId).toBe(bookmarkWallet.walletId);
      await gotoProjectPage(
        page,
        projectId,
        `/dashboard/wallets/${encodeURIComponent(bookmarkWallet.id)}`
      );
      await expect(
        page.getByRole("heading", { name: "Wallet Identity Bookmark", exact: true })
      ).toBeVisible();
      const newDesignWallets = await page.locator("[data-wallet-detail]").isVisible();
      const bookmarkParams = new URLSearchParams({ label: "Wallet & Treasury" });
      bookmarkParams.append("filter", "a");
      bookmarkParams.append("filter", "b");
      if (newDesignWallets) bookmarkParams.set("tab", "settings");
      const bookmarkedQuery = `?${bookmarkParams}`;
      await gotoProjectPage(
        page,
        projectId,
        `/dashboard/wallets/${encodeURIComponent(bookmarkWallet.walletId)}${bookmarkedQuery}`
      );
      const canonicalPath = projectHref(projectId, `/dashboard/wallets/${bookmarkWallet.id}`);
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
        page.getByRole("heading", { name: "Wallet Identity Bookmark", exact: true })
      ).toBeVisible();
      await page.reload();
      await expectCanonicalBookmark();
    });
  });
