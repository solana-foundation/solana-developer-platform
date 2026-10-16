import { randomUUID } from "node:crypto";
import { type BrowserContext, expect, type Page, type Route, test } from "@playwright/test";
import { projectHref } from "@/lib/dashboard-project-path";
import { createClerkBearerTokenProvider } from "../support/auth-session";
import { authStatePath } from "../support/auth-state";
import { createLocalApiClient, type LocalApiClient } from "../support/local-api-client";
import {
  createExternalSolanaAddress,
  getBootstrapApiBaseUrl,
  provisionWithAdminSession,
  seedCounterpartyWithSolanaAccount,
} from "../support/local-dashboard-bootstrap";
import { bootstrapLocalPaymentFixtures } from "../support/local-issuance-bootstrap";

/**
 * The dashboard's Idempotency-Key contract (HOO-1918), driven through the real UI against the
 * local API: one key per user action, kept across double submits, lost answers, refusals that
 * settle nothing and reloads, and retired by a success, a replay or a 422. Each test
 * checks the keys the browser sent and what the API holds afterwards.
 */

const TRANSFERS = "/api/dashboard/payments/transfers";
const REQUESTS = "/api/dashboard/payments/requests";
const RECURRING = "/api/dashboard/payments/recurring-payments";
const NOT_PERSISTED = "not keeping the request's retry key";

interface Fixture {
  projectId: string;
  walletId: string;
  walletLabel: string;
  tokenMint: string;
  tokenSymbol: string;
  counterpartyId: string;
  counterpartyName: string;
  accountId: string;
  accountLabel: string;
}

interface SentRequest {
  method: string;
  path: string;
  key: string | null;
  body: string | null;
}

/** Every mutating dashboard API request the page sends, with its Idempotency-Key. */
function recordRequests(page: Page): SentRequest[] {
  const sent: SentRequest[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" || !url.pathname.startsWith("/api/dashboard/")) return;
    sent.push({
      method: request.method(),
      path: url.pathname,
      key: request.headers()["idempotency-key"] ?? null,
      body: request.postData(),
    });
  });
  return sent;
}

function keysFor(sent: SentRequest[], method: string, path: string): (string | null)[] {
  return sent.filter((r) => r.method === method && r.path === path).map((r) => r.key);
}

/**
 * Scripts the answers to a route's requests of one method, in order. `lost` lets the request
 * reach the API and run, then drops its answer, as a dropped connection does. `pass`, or a step
 * past the end, forwards untouched.
 */
type Step = "pass" | "lost" | { status: number; message: string };

async function scriptAnswers(
  target: Page | BrowserContext,
  path: string,
  method: string,
  steps: Step[]
) {
  let attempt = 0;
  await target.route(`**${path}`, async (route: Route) => {
    if (route.request().method() !== method) return route.fallback();
    const step = steps[attempt++] ?? "pass";
    if (step === "pass") return route.fallback();
    if (step === "lost") {
      // The server answers; only the answer is dropped. A request that fails
      // or is refused is a broken test, not the lost answer it scripts.
      const answer = await route.fetch();
      if (!answer.ok()) {
        throw new Error(
          `${method} ${path} answered ${answer.status()} before its answer was dropped`
        );
      }
      return route.abort("failed");
    }
    return route.fulfill({
      status: step.status,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "TEST", message: step.message } }),
    });
  });
}

/** The API as the signed-in test user, for reading what the dashboard's requests created. */
function apiFor(page: Page, projectId: string): LocalApiClient {
  return createLocalApiClient(
    getBootstrapApiBaseUrl(),
    createClerkBearerTokenProvider(page),
    projectId
  );
}

test.describe
  .serial("dashboard Idempotency-Key per user action", () => {
    let fx: Fixture;

    test.beforeAll(async ({ browser }) => {
      fx = await provisionWithAdminSession(browser, async (session) => {
        const fixtures = await bootstrapLocalPaymentFixtures({
          identity: session.identity,
          bearerToken: session.getBearerToken,
          tier: "enterprise",
        });
        const api = createLocalApiClient(
          getBootstrapApiBaseUrl(),
          session.getBearerToken,
          fixtures.projectId
        );
        await api.post(`/v1/issuance/tokens/${fixtures.token.id}/mint`, {
          mint: { destination: fixtures.wallets.treasury.publicKey, amount: "100" },
        });
        const suffix = randomUUID().slice(0, 8);
        const accountLabel = `E2E Idempotency ${suffix}`;
        const counterparty = await seedCounterpartyWithSolanaAccount(api, {
          displayName: `E2E Idempotency Payee ${suffix}`,
          accountLabel,
          destinationAddress: await createExternalSolanaAddress(),
        });
        const { treasury } = fixtures.wallets;
        if (!treasury.label || !fixtures.token.mintAddress) {
          throw new Error("Payment bootstrap did not return a labelled wallet and a minted token");
        }
        return {
          projectId: fixtures.projectId,
          walletId: treasury.id,
          walletLabel: treasury.label,
          tokenMint: fixtures.token.mintAddress,
          tokenSymbol: fixtures.token.symbol,
          counterpartyId: counterparty.counterpartyId,
          counterpartyName: counterparty.displayName,
          accountId: counterparty.accountId,
          accountLabel,
        };
      });
    });

    // ------------------------------------------------------------------ transfers

    async function countTransfers(page: Page, amount: string): Promise<number> {
      const transfers = await apiFor(page, fx.projectId).get<{ amount?: string }[]>(
        `/v1/payments/transfers?custodyWalletId=${fx.walletId}&pageSize=100`
      );
      return transfers.filter((t) => Number(t.amount) === Number(amount)).length;
    }

    /** Fills Pay for `amount` SOL and returns the review step's Send button. */
    async function reviewTransfer(page: Page, amount: string) {
      const app = page.locator("main");
      await page.goto(projectHref(fx.projectId, "/dashboard/payments/pay"));
      await app.getByRole("button", { name: "Contact", exact: true }).click();
      await page.getByPlaceholder("Search contacts").fill(fx.counterpartyName);
      await page.getByRole("button", { name: fx.counterpartyName }).click();
      const destination = app.getByRole("button", { name: "Destination", exact: true });
      await expect(destination).toBeEnabled({ timeout: 120_000 });
      await destination.click();
      await page.getByRole("button", { name: fx.accountLabel }).click();
      await app.getByRole("button", { name: "Source wallet" }).click();
      await page.getByPlaceholder("Search wallets").fill(fx.walletLabel);
      await page.getByRole("button", { name: fx.walletLabel }).first().click();
      await app.getByRole("button", { name: "Token", exact: true }).click();
      await page.getByRole("button", { name: "SOL", exact: true }).click();
      await app.getByLabel("Amount", { exact: true }).fill(amount);
      const toReview = app.getByRole("button", { name: "Continue to review", exact: true });
      await expect(toReview).toBeEnabled({ timeout: 120_000 });
      await toReview.click();
      const send = app.getByRole("button", { name: "Send transfer", exact: true });
      await expect(send).toBeEnabled({ timeout: 120_000 });
      return send;
    }

    const submitted = (page: Page) =>
      expect(page.locator("main").getByText("Transfer submitted")).toBeVisible({
        timeout: 120_000,
      });
    const failed = (page: Page) =>
      expect(page.getByText("Transfer failed.").first()).toBeVisible({ timeout: 60_000 });

    test("a rapid triple click sends one key and makes one transfer", async ({ page }) => {
      const amount = "0.0011";
      const sent = recordRequests(page);
      const send = await reviewTransfer(page, amount);
      await send.evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
        button.click();
      });
      await submitted(page);

      const keys = keysFor(sent, "POST", TRANSFERS);
      expect(keys.every(Boolean)).toBe(true);
      expect(new Set(keys).size).toBe(1);
      expect(await countTransfers(page, amount)).toBe(1);
    });

    test("a retry after a lost answer resends the key and the API replays", async ({ page }) => {
      const amount = "0.0012";
      const sent = recordRequests(page);
      await scriptAnswers(page, TRANSFERS, "POST", ["lost"]);
      const send = await reviewTransfer(page, amount);
      await send.click();
      await failed(page);
      const replay = page.waitForResponse(
        (r) => r.url().endsWith(TRANSFERS) && r.request().method() === "POST"
      );
      await send.click();
      // The transfer route answers a retry from the key's stored response or
      // its transfer row (`idempotent()`, `replayFromRecord`); both mark it.
      expect((await replay).headers()["idempotent-replayed"]).toBe("true");
      await submitted(page);

      const keys = keysFor(sent, "POST", TRANSFERS);
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
      expect(await countTransfers(page, amount)).toBe(1);
    });

    for (const refusal of [
      { status: 429, message: "Too many requests" },
      { status: 401, message: "Session expired" },
    ]) {
      test(`a ${refusal.status} after a lost answer keeps the key for the retry`, async ({
        page,
      }) => {
        const amount = refusal.status === 429 ? "0.0016" : "0.0017";
        const sent = recordRequests(page);
        await scriptAnswers(page, TRANSFERS, "POST", ["lost", refusal]);
        const send = await reviewTransfer(page, amount);
        await send.click();
        await failed(page);
        await send.click();
        await expect(page.getByText(refusal.message).first()).toBeVisible({ timeout: 60_000 });
        await send.click();
        await submitted(page);

        const keys = keysFor(sent, "POST", TRANSFERS);
        expect(keys).toHaveLength(3);
        expect(new Set(keys).size).toBe(1);
        expect(await countTransfers(page, amount)).toBe(1);
      });
    }

    test("the key survives a reload after a lost answer", async ({ page }) => {
      const amount = "0.0022";
      const sent = recordRequests(page);
      await scriptAnswers(page, TRANSFERS, "POST", ["lost"]);
      const send = await reviewTransfer(page, amount);
      await send.click();
      await failed(page);
      await page.reload();
      await (await reviewTransfer(page, amount)).click();
      await submitted(page);

      const keys = keysFor(sent, "POST", TRANSFERS);
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
      expect(await countTransfers(page, amount)).toBe(1);
    });

    test("a money route refuses to send when the browser will not keep the key", async ({
      browser,
    }) => {
      const context = await browser.newContext({ storageState: authStatePath });
      await context.addInitScript(() => {
        const setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (name: string, value: string) {
          if (this === window.sessionStorage && name.includes("idempotency")) {
            throw new DOMException("quota exceeded", "QuotaExceededError");
          }
          return setItem.call(this, name, value);
        };
      });
      const page = await context.newPage();
      try {
        const amount = "0.0018";
        const sent = recordRequests(page);
        await (await reviewTransfer(page, amount)).click();
        await failed(page);
        await expect(page.getByText(NOT_PERSISTED).first()).toBeVisible();
        expect(keysFor(sent, "POST", TRANSFERS)).toHaveLength(0);
        expect(await countTransfers(page, amount)).toBe(0);
      } finally {
        await context.close();
      }
    });

    // ----------------------------------------------------------- payment requests

    async function countRequests(page: Page, amount: string): Promise<number> {
      const { paymentRequests } = await apiFor(page, fx.projectId).get<{
        paymentRequests: { amount: string }[];
      }>(`/v1/payments/requests?pageSize=${100}`);
      return paymentRequests.filter((r) => Number(r.amount) === Number(amount)).length;
    }

    /** Fills a 7-day SOL request for `amount` and returns its create button. */
    async function requestForm(page: Page, amount: string) {
      const app = page.locator("main");
      await page.goto(projectHref(fx.projectId, "/dashboard/payments/requests/new"));
      await page.locator("#payment-request-amount").fill(amount);
      await app.getByRole("button", { name: "Token", exact: true }).click();
      await page
        .getByRole("option", { name: "SOL", exact: true })
        .or(page.getByRole("button", { name: "SOL", exact: true }))
        .first()
        .click();
      const wallet = app.getByRole("button", { name: "Destination wallet" });
      if (!(await wallet.innerText()).includes(fx.walletLabel)) {
        await wallet.click();
        await page
          .getByRole("option", { name: new RegExp(fx.walletLabel) })
          .or(page.getByRole("button", { name: new RegExp(fx.walletLabel) }))
          .first()
          .click();
      }
      await app.getByRole("button", { name: "Link expires" }).click();
      await page
        .getByRole("option", { name: "7 days", exact: true })
        .or(page.getByRole("button", { name: "7 days", exact: true }))
        .first()
        .click();
      const create = page.getByRole("button", { name: "Create and copy link" });
      await expect(create).toBeEnabled({ timeout: 60_000 });
      return create;
    }

    const requestCreated = (page: Page) =>
      expect(page).toHaveURL(/\/payments\/requests\/(?!new)[^/]+$/, { timeout: 120_000 });

    test("a payment request edited A to B and back to A resends A's key and body", async ({
      page,
    }) => {
      const amountA = "0.31";
      const sent = recordRequests(page);
      await scriptAnswers(page, REQUESTS, "POST", ["lost", { status: 503, message: "down" }]);
      const create = await requestForm(page, amountA);
      await create.click();
      await expect(page.locator("[data-sonner-toast]").first()).toBeVisible({ timeout: 60_000 });
      await page.locator("#payment-request-amount").fill("0.32");
      await create.click();
      await expect(page.getByText("down").first()).toBeVisible({ timeout: 60_000 });
      await page.locator("#payment-request-amount").fill(amountA);
      await create.click();
      await requestCreated(page);

      const posts = sent.filter((r) => r.method === "POST" && r.path === REQUESTS);
      expect(posts).toHaveLength(3);
      expect(posts[1]?.key).not.toBe(posts[0]?.key);
      expect(posts[2]?.key).toBe(posts[0]?.key);
      // The frozen expiry: the retry is byte-for-byte the first attempt's request.
      expect(posts[2]?.body).toBe(posts[0]?.body);
      expect(await countRequests(page, amountA)).toBe(1);
    });

    test("a payment request's key and frozen expiry survive a reload", async ({ page }) => {
      const amount = "0.61";
      const sent = recordRequests(page);
      await scriptAnswers(page, REQUESTS, "POST", ["lost"]);
      await (await requestForm(page, amount)).click();
      await expect(page.locator("[data-sonner-toast]").first()).toBeVisible({ timeout: 60_000 });
      await page.reload();
      await (await requestForm(page, amount)).click();
      await requestCreated(page);

      const posts = sent.filter((r) => r.method === "POST" && r.path === REQUESTS);
      expect(posts).toHaveLength(2);
      expect(posts[1]?.key).toBe(posts[0]?.key);
      expect(posts[1]?.body).toBe(posts[0]?.body);
      expect(await countRequests(page, amount)).toBe(1);
    });

    // ------------------------------------------------------------- recurring edit

    test("a recurring edit retried after a lost answer resends its key and applies once", async ({
      page,
    }) => {
      await page.goto(projectHref(fx.projectId, "/dashboard/payments/recurring"));
      const api = apiFor(page, fx.projectId);
      const { recurringPayment } = await api.post<{ recurringPayment: { id: string } }>(
        "/v1/payments/recurring-payments",
        {
          sourceCustodyWalletId: fx.walletId,
          counterpartyId: fx.counterpartyId,
          counterpartyAccountId: fx.accountId,
          token: fx.tokenMint,
          amount: "2.2",
          periodHours: 24,
        }
      );
      const id = recurringPayment.id;
      await api.post(`/v1/payments/recurring-payments/${id}/activate`, {});
      const schedule = async () =>
        (
          await api.get<{ recurringPayment: { status: string; amount: string } }>(
            `/v1/payments/recurring-payments/${id}`
          )
        ).recurringPayment;
      await expect.poll(async () => (await schedule()).status, { timeout: 120_000 }).toBe("active");

      const path = `${RECURRING}/${id}`;
      const sent = recordRequests(page);
      await scriptAnswers(page, path, "PATCH", ["lost"]);
      await page.goto(projectHref(fx.projectId, `/dashboard/payments/recurring/${id}`));
      const amountField = page.locator("#schedule-edit-amount");
      const openEdit = async () => {
        if (await amountField.isVisible()) return;
        await page
          .locator("main")
          .getByRole("button", { name: "Edit", exact: true })
          .first()
          .click();
        await expect(amountField).toBeVisible({ timeout: 30_000 });
      };

      await openEdit();
      await amountField.fill("2.3");
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByText("Schedule update failed.").first()).toBeVisible({
        timeout: 60_000,
      });
      await openEdit();
      await amountField.fill("2.3");
      const retry = page.waitForResponse(
        (r) => r.url().endsWith(path) && r.request().method() === "PATCH"
      );
      await page.getByRole("button", { name: "Save changes" }).click();
      expect((await retry).headers()["idempotent-replayed"]).toBe("true");
      expect(Number((await schedule()).amount)).toBe(2.3);

      await page.reload();
      await openEdit();
      await amountField.fill("2.4");
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByText("Schedule updated.").first()).toBeVisible({ timeout: 60_000 });

      const keys = keysFor(sent, "PATCH", path);
      expect(keys).toHaveLength(3);
      expect(keys.every(Boolean)).toBe(true);
      expect(keys[1]).toBe(keys[0]);
      expect(keys[2]).not.toBe(keys[0]);
      expect(Number((await schedule()).amount)).toBe(2.4);
    });
  });
