import { expect as playwrightExpect, test } from "@playwright/test";
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
      await expect(
        page.getByRole("heading", { name: "Wallet Identity B", exact: true })
      ).toBeVisible();
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
      const { otherApi, otherProjectId, otherWallet } = fixture;
      const walletBalances = parseWalletBalanceResponse(
        {
          data: await otherApi.get<unknown>(
            `/v1/payments/wallets/${encodeURIComponent(otherWallet.walletId)}/balances`
          ),
        },
        otherWallet.id
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
  });
