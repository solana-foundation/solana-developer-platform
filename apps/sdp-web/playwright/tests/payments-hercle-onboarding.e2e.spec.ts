import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CounterpartyResponse } from "@sdp/types/counterparties";
import type { PaymentRampQuote, PaymentTransferSummary } from "@sdp/types/payments";
import type { CounterpartyRequirements, RequirementField } from "@sdp/types/ramp-requirements";
import { projectHref } from "@/lib/dashboard-project-path";
import { createLocalApiClient } from "../support/local-api-client";
import {
  bootstrapLocalWalletFixtures,
  getBootstrapApiBaseUrl,
  getPlaywrightCustodyProvider,
  provisionWithAdminSession,
} from "../support/local-dashboard-bootstrap";

/**
 * Hercle is KYB-gated and on-ramp only.
 * The deposit wizard collects the business's registration details and its acceptance of Hercle's terms.
 * Until Hercle approves the business, its verification lifecycle shows in place of the wire instructions.
 * The lifecycle is Hercle's, so every state is stubbed at the dashboard's requirements route.
 *
 * The server decides whether Hercle is offered at all, from the API's managed Hercle keys.
 * No route stub can fake that: on a stack without them the provider tile is disabled and the specs skip.
 */
const VERIFICATION_URL = "https://verify.hercle.test/simulate/partner-verification/acct_1";
const TRANSFER_ID = "xfr_7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
// biome-ignore lint/security/noSecrets: a public sample IBAN, not a credential.
const SAMPLE_IBAN = "CH9300762011623852957";

const REQUIREMENTS_ROUTE = "**/api/dashboard/counterparty/*/requirements*";

/** A slice of Hercle's KYB form: one registration field and the two consents it requires. */
const KYB_FIELDS: RequirementField[] = [
  {
    kind: "text",
    key: "registrationNumber",
    label: "Company registration number",
    required: true,
    minLength: 2,
    maxLength: 64,
  },
  {
    kind: "consent",
    key: "acceptHercleTerms",
    label: "I declare that I have read and accepted Hercle's",
    documentLabel: "Terms & Conditions",
    documentUrl: "https://hercle.com/terms/",
    required: true,
  },
  {
    kind: "consent",
    key: "acceptHerclePrivacy",
    label: "I declare that I have read, agreed and accepted Hercle's",
    documentLabel: "Privacy Policy",
    documentUrl: "https://hercle.com/privacy/",
    required: true,
  },
];

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

const HERCLE_QUOTE = {
  id: "ord_e2e_hercle",
  provider: "hercle",
  status: "pending",
  deliveryMode: "manual_instructions",
  expiresAt: "2099-01-01T00:15:00Z",
  paymentInstructions: [
    {
      provider: "hercle",
      kind: "fiat_funding",
      fiatCurrency: "USD",
      bankAccount: {
        iban: SAMPLE_IBAN,
        bic: "HRCLCHZZ",
        bankName: "E2E Bank",
        accountHolder: "Hercle SA",
        paymentReference: "HRC-ORD-E2E",
        payerAccountHolder: "E2E Hercle Business",
      },
      instructionsNotes: "Wire 100.00 USD from a bank account held by E2E Hercle Business.",
    },
  ],
} as const satisfies PaymentRampQuote;

test.describe
  .serial("dashboard payments — Hercle onboarding", () => {
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

        // Hercle serves business counterparties only; an individual never gets its tile.
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

    for (const state of ONBOARDING_STATES) {
      test(`renders the ${state.name} panel in place of the wire instructions`, async ({
        page,
      }) => {
        await stubRequirements(page, state.requirements, state.requirements);
        await reachProviderStep(page, { projectId, counterpartyName, walletLabel });

        const app = page.locator("main");
        await expect(app.getByText(state.heading, { exact: true })).toBeVisible();
        // A wire from an unverified business cannot be settled, so no account to wire to shows.
        await expect(app.getByText("Payment reference")).toHaveCount(0);

        const verificationAction = app.getByRole("button", { name: /complete verification/i });
        if (state.expectsVerificationAction) {
          // The hosted link opens in a new tab through the trusted-destination guard; it is never an href.
          await page
            .context()
            .route("https://verify.hercle.test/**", (route) =>
              route.fulfill({ status: 200, contentType: "text/html", body: "<title>KYB</title>" })
            );
          const popupPromise = page.waitForEvent("popup");
          await verificationAction.click();
          const popup = await popupPromise;
          await popup.waitForLoadState();
          expect(popup.url()).toBe(VERIFICATION_URL);
          await popup.close();
        } else {
          // An action beside a verdict in review or refused would send the business back into a finished flow.
          await expect(verificationAction).toHaveCount(0);
        }
      });
    }

    test("holds the KYB step until both of Hercle's documents are accepted", async ({ page }) => {
      await stubRequirements(
        page,
        { provider: "hercle", direction: "onramp", status: "collect", fields: KYB_FIELDS },
        ONBOARDING_STATES[0].requirements
      );
      await fillDepositDetails(page, { projectId, counterpartyName, walletLabel });

      const app = page.locator("main");
      const next = app.getByRole("button", { name: "Continue", exact: true });
      await expect(app.getByText("What Hercle needs")).toBeVisible();
      await app.getByLabel("Company registration number").fill("CHE-123.456.789");
      await expect(next).toBeDisabled();

      const terms = app.getByRole("link", { name: /Terms & Conditions/ });
      await expect(terms).toHaveAttribute("href", "https://hercle.com/terms/");
      await app.getByRole("checkbox", { name: /Terms & Conditions/ }).check();
      await expect(next).toBeDisabled();
      await app.getByRole("checkbox", { name: /Privacy Policy/ }).check();
      await expect(next).toBeEnabled();

      const advance = page.waitForRequest(
        (request) => request.method() === "POST" && /\/requirements$/.test(request.url())
      );
      await next.click();
      const sent = (await advance).postDataJSON() as { collectedData?: Record<string, string> };
      expect(sent.collectedData).toEqual({
        registrationNumber: "CHE-123.456.789",
        acceptHercleTerms: "true",
        acceptHerclePrivacy: "true",
      });
    });

    test("shows the wire instructions once Hercle approves the business", async ({ page }) => {
      const ready: CounterpartyRequirements = {
        provider: "hercle",
        direction: "onramp",
        status: "ready",
      };
      await stubRequirements(page, ready, ready);
      await page.route("**/api/dashboard/payments/ramps/onramp/quote", (route) =>
        route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ data: { quote: HERCLE_QUOTE, transferId: TRANSFER_ID } }),
        })
      );
      const transfer: PaymentTransferSummary = {
        id: TRANSFER_ID,
        custodyWalletId: "cwlt_e2e",
        providerWalletId: "wallet_e2e",
        status: "awaiting_payment",
        signature: null,
        rampsMemo: {},
        type: "onramp",
        provider: "hercle",
      };
      await page.route(`**/api/dashboard/payments/transfers/${TRANSFER_ID}*`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: { transfer } }),
        })
      );
      await reachProviderStep(page, { projectId, counterpartyName, walletLabel });

      const app = page.locator("main");
      await expect(app.getByText(SAMPLE_IBAN)).toBeVisible();
      await expect(app.getByText("HRC-ORD-E2E")).toBeVisible();
      await expect(app.getByText("Pay from an account held by")).toBeVisible();
      await expect(app.getByRole("button", { name: /complete verification/i })).toHaveCount(0);
    });
  });

/** Hercle's provider tile, or a skip when this stack's API does not offer Hercle. */
async function hercleTile(page: Page): Promise<Locator> {
  const radio = page.locator("main").getByRole("radio", { name: /^Hercle/ });
  await expect(page.locator("main").getByText("Choose a provider")).toBeVisible({
    timeout: 120_000,
  });
  const offered = (await radio.count()) > 0 && (await radio.isEnabled());
  test.skip(!offered, "This stack's API holds no Hercle sandbox keys, so Hercle is not offered.");
  return radio;
}

/**
 * The deposit wizard's details step: the business contact, the destination wallet, an amount, and Hercle.
 * USD into USDC is both the wizard's default pair and a Hercle corridor.
 */
async function fillDepositDetails(
  page: Page,
  input: { projectId: string; counterpartyName: string; walletLabel: string }
): Promise<void> {
  const app = page.locator("main");
  await page.goto(projectHref(input.projectId, "/dashboard/payments/deposit?tab=provider"));

  await app.getByRole("button", { name: "Contact", exact: true }).click();
  await page.getByPlaceholder("Search contacts").fill(input.counterpartyName);
  await page.getByRole("button", { name: input.counterpartyName }).click();

  await app.getByRole("button", { name: "Destination wallet" }).click();
  await page.getByPlaceholder("Search wallets").fill(input.walletLabel);
  await page.getByRole("button", { name: input.walletLabel }).click();
  await app.getByLabel("Amount", { exact: true }).fill("100");

  const tile = await hercleTile(page);
  await tile.check({ force: true });

  const next = app.getByRole("button", { name: "Continue", exact: true });
  await expect(next).toBeEnabled({ timeout: 120_000 });
  await next.click();
}

/**
 * Drives the wizard to its provider step for a business Hercle already holds.
 * It passes the details, the memo (which submits the requirements advance) and the review.
 * The provider step renders whatever the advance answered.
 */
async function reachProviderStep(
  page: Page,
  input: { projectId: string; counterpartyName: string; walletLabel: string }
): Promise<void> {
  await fillDepositDetails(page, input);
  const app = page.locator("main");

  const next = app.getByRole("button", { name: "Continue", exact: true });
  await expect(next).toBeEnabled();
  await next.click();

  const continueWithHercle = app.getByRole("button", { name: "Continue with Hercle" });
  await expect(continueWithHercle).toBeEnabled({ timeout: 120_000 });
  await continueWithHercle.click();
}

/**
 * Answers the requirements read with `read` and the advance with `advance`.
 * Both go in the `{ data }` envelope the dashboard route proxies through from the API.
 */
async function stubRequirements(
  page: Page,
  read: CounterpartyRequirements,
  advance: CounterpartyRequirements
): Promise<void> {
  await page.route(REQUIREMENTS_ROUTE, async (route) => {
    const data = route.request().method() === "POST" ? advance : read;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data }),
    });
  });
}
