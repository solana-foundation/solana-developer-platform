import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import type { CounterpartyResponse } from "@sdp/types";
import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { createLocalApiClient } from "../support/local-api-client";
import {
  bootstrapLocalWalletFixtures,
  getBootstrapApiBaseUrl,
  getPlaywrightCustodyProvider,
  provisionWithAdminSession,
  seedProjectCookie,
} from "../support/local-dashboard-bootstrap";

/**
 * Hercle is KYB-gated and on-ramp only: until verification reaches `ready`, the deposit wizard's
 * provider step shows an onboarding panel instead of the wire instructions. The panel is driven by
 * the requirements advance the wizard submits when it leaves the memo step, so the lifecycle
 * states are stubbed at that response rather than provisioned through a real verification.
 */
const VERIFICATION_URL = "https://verify.hercle.test/simulate/partner-verification/acct_1";

const REQUIREMENTS_ROUTE = "**/api/dashboard/counterparty/*/requirements*";

const ONBOARDING_STATES: {
  name: string;
  requirements: CounterpartyRequirements;
  heading: string;
  expectsVerificationAction: boolean;
}[] = [
  {
    name: "verification required",
    requirements: {
      provider: "hercle",
      direction: "onramp",
      status: "customer_verification_required",
      verificationUrl: VERIFICATION_URL,
    },
    heading: "Verify your business",
    expectsVerificationAction: true,
  },
  {
    name: "verifying",
    requirements: { provider: "hercle", direction: "onramp", status: "customer_verifying" },
    heading: "Verification in review",
    expectsVerificationAction: false,
  },
  {
    name: "verification failed",
    requirements: {
      provider: "hercle",
      direction: "onramp",
      status: "customer_verification_failed",
    },
    heading: "Business verification was not approved",
    expectsVerificationAction: false,
  },
];

test.describe
  .serial("dashboard payments — Hercle onboarding panel", () => {
    let projectId = "";
    let walletLabel = "";
    let counterpartyName = "";

    test.beforeAll(async ({ browser }) => {
      const fixtures = await provisionWithAdminSession(browser, async (session) => {
        const bootstrap = await bootstrapLocalWalletFixtures({
          identity: session.identity,
          bearerToken: session.getBearerToken,
          provider: getPlaywrightCustodyProvider(),
          walletCount: 1,
          tier: "enterprise",
        });
        const wallet = bootstrap.wallets[0];
        if (!wallet?.label) {
          throw new Error("Hercle onboarding bootstrap did not create a labelled wallet");
        }

        // Hercle serves business counterparties only; an individual never gets its provider card.
        const displayName = `E2E Hercle Business ${randomUUID().slice(0, 8)}`;
        const api = createLocalApiClient(
          getBootstrapApiBaseUrl(),
          session.getBearerToken,
          bootstrap.projectId
        );
        await api.post<CounterpartyResponse>("/v1/counterparties", {
          entityType: "business",
          displayName,
        });

        return { projectId: bootstrap.projectId, walletLabel: wallet.label, displayName };
      });
      projectId = fixtures.projectId;
      walletLabel = fixtures.walletLabel;
      counterpartyName = fixtures.displayName;
    });

    test.beforeEach(async ({ page }) => {
      await seedProjectCookie(page, projectId);
    });

    for (const state of ONBOARDING_STATES) {
      test(`renders the ${state.name} panel`, async ({ page }) => {
        await stubRequirements(page, state.requirements);
        await reachProviderStep(page, { counterpartyName, walletLabel });

        // Exact: the panel's description repeats the heading's words in a sentence.
        await expect(page.getByText(state.heading, { exact: true })).toBeVisible();

        const verificationAction = page.getByRole("button", { name: /complete verification/i });

        if (state.expectsVerificationAction) {
          // The hosted link opens in a new tab through the trusted-destination guard; it is never an href.
          await page
            .context()
            .route("https://verify.hercle.test/**", (route) =>
              route.fulfill({ status: 200, contentType: "text/html", body: "<title>KYB</title>" })
            );
          const popupPromise = page.waitForEvent("popup");
          await verificationAction.first().click();
          const popup = await popupPromise;
          await popup.waitForLoadState();
          expect(popup.url()).toBe(VERIFICATION_URL);
          await popup.close();
        } else {
          // An action beside a terminal or in-review verdict would send the applicant back into a finished flow.
          await expect(verificationAction).toHaveCount(0);
        }
      });
    }

    test("withholds the wire instructions until verification completes", async ({ page }) => {
      await stubRequirements(page, {
        provider: "hercle",
        direction: "onramp",
        status: "customer_verifying",
      });
      await reachProviderStep(page, { counterpartyName, walletLabel });

      await expect(page.getByText("Verification in review", { exact: true })).toBeVisible();
      // A wire from an unverified business cannot be settled, so no account or reference to wire to
      // may be shown before Hercle approves the business.
      await expect(page.getByText("Account number")).toHaveCount(0);
      await expect(page.getByText("Payment reference")).toHaveCount(0);
    });
  });

/**
 * Drives the deposit wizard up to the Hercle provider step: counterparty, fiat method, then the
 * destination wallet, amount and provider on the deposit step. USD → USDC is both the wizard's
 * default pair and a Hercle corridor, so the pair is left as is. Leaving the memo step submits the
 * requirements advance, and the provider step renders whatever lifecycle state that answered.
 */
async function reachProviderStep(
  page: Page,
  input: { counterpartyName: string; walletLabel: string }
): Promise<void> {
  const app = page.locator("main");
  const next = app.getByRole("button", { name: "Next", exact: true });

  await page.goto("/dashboard/payments/deposit");

  await app.getByRole("button", { name: "Counterparty", exact: true }).click();
  await page.getByPlaceholder("Search counterparties").fill(input.counterpartyName);
  await page.getByRole("button", { name: input.counterpartyName }).click();
  await expect(next).toBeEnabled({ timeout: 120_000 });
  await next.click();

  await app.getByRole("button", { name: "Deposit with fiat" }).click();
  await expect(next).toBeEnabled();
  await next.click();

  await app.getByRole("button", { name: "Destination wallet" }).click();
  await page.getByPlaceholder("Search wallets").fill(input.walletLabel);
  await page.getByRole("button", { name: input.walletLabel }).click();
  await app.getByLabel("Amount", { exact: true }).fill("100");
  await app.getByRole("button", { name: "Hercle" }).click();
  await expect(next).toBeEnabled({ timeout: 120_000 });
  await next.click();

  await expect(next).toBeEnabled();
  await next.click();
}

/**
 * Answers both the requirements GET and the advance POST with one lifecycle state, in the `{ data }`
 * envelope the dashboard route proxies through from the API.
 */
async function stubRequirements(page: Page, requirements: CounterpartyRequirements): Promise<void> {
  await page.route(REQUIREMENTS_ROUTE, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: requirements }),
    });
  });
}
