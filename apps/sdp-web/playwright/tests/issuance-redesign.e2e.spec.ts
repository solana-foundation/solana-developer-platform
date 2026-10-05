import { expect, type Page, type TestInfo, test } from "@playwright/test";
import { clearIssuanceFixtures, type IssuanceFixtures } from "../support/issuance-fixtures";
import { provisionWithAdminSession, seedProjectCookie } from "../support/local-dashboard-bootstrap";
import { bootstrapLocalIssuanceFixtures } from "../support/local-issuance-bootstrap";

// The new design's Issuance (new-design-issuance on): the token list, the draft flow and one
// token's page. issuance.e2e.spec.ts keeps covering the previous design, which production
// still serves. Both start from the same seeded fixtures. Mint, burn, lock supply and authority
// edits open in place on the new design; the confirmation dialogs are shared with the previous
// design, so their steps match it.

type TokenTab = "overview" | "details" | "public" | "compliance" | "operations" | "permissions";

// The API admits 300 dashboard requests a minute per user, and one page load costs about 20
// (every server render and dashboard route also reads /v1/projects). The suite runs in one
// job, so it never polls by reloading: an operation refreshes the page itself once it lands,
// and a wait reloads once at most, when the in-place refresh did not show the change.
// Back-to-back tests still add up, so each test also starts on a fresh budget (see
// waitForFreshRateWindow).
const RATE_WINDOW_MS = 60_000;

/**
 * Waits until the API's rate limit no longer counts any request made before `lastActivity`.
 * The limit adds the current minute's count to a fading share of the previous minute's, so
 * old requests stop counting once a whole minute bucket has passed after theirs: 60 to 120
 * seconds of quiet. The wait is added to the test's timeout.
 */
async function waitForFreshRateWindow(lastActivity: number, testInfo: TestInfo): Promise<void> {
  const freshFrom = Math.floor(lastActivity / RATE_WINDOW_MS) * RATE_WINDOW_MS + 2 * RATE_WINDOW_MS;
  const wait = freshFrom - Date.now();
  if (wait <= 0) return;
  testInfo.setTimeout(testInfo.timeout + wait);
  await new Promise((resolve) => setTimeout(resolve, wait));
}

async function eventually(reopen: () => Promise<void>, check: () => Promise<void>) {
  await check().catch(async () => {
    await reopen();
    await check();
  });
}

async function withRetry(page: Page, ready: () => Promise<void>): Promise<void> {
  await ready().catch(async () => {
    const retryButton = page.getByRole("button", { name: "Retry", exact: true });
    if ((await retryButton.count()) > 0) {
      await retryButton.click();
    } else {
      await page.reload({ waitUntil: "domcontentloaded" });
    }
    await ready();
  });
}

async function gotoIssuanceList(page: Page): Promise<void> {
  await page.goto("/dashboard/issuance", { waitUntil: "domcontentloaded" });
  const createDraft = page.getByRole("link", { name: "Create a draft", exact: true }).first();
  await withRetry(page, () => expect(createDraft).toBeVisible({ timeout: 60_000 }));
}

async function gotoToken(page: Page, tokenId: string, tab: TokenTab = "overview"): Promise<void> {
  const query = tab === "overview" ? "" : `?tab=${tab}`;
  await page.goto(`/dashboard/issuance/${tokenId}${query}`, { waitUntil: "domcontentloaded" });
  await withRetry(page, () =>
    expect(page.locator(`[data-token-page="${tab}"]`)).toBeVisible({ timeout: 60_000 })
  );
}

/**
 * The value beside a record line's label, e.g. "Issued supply": the `dd` right after that
 * `dt`. A `div` filter would also match the blocks around the line and return their first
 * line's value instead.
 */
function recordValue(page: Page, label: string) {
  return page
    .locator("dt", { hasText: new RegExp(`^${label}$`) })
    .first()
    .locator("xpath=following-sibling::dd[1]");
}

/**
 * Opens Compliance and waits for its access list to load: a loaded list shows its entries or
 * says it has none, while one still loading shows neither, so a check that an entry is gone
 * would otherwise pass against the empty loading state.
 */
async function openLoadedComplianceList(page: Page, tokenId: string): Promise<void> {
  const compliance: TokenTab = "compliance";
  await gotoToken(page, tokenId, compliance);
  const tab = page.locator(`[data-token-page="${compliance}"]`);
  await expect(
    tab.getByText("Nothing is on the list yet").or(tab.locator("tbody tr").first())
  ).toBeVisible({ timeout: 60_000 });
}

function operationButton(page: Page, operation: string) {
  return page.locator(`[data-token-operation="${operation}"]`).getByRole("button");
}

async function waitForToast(page: Page, text: string, previousCount = 0): Promise<void> {
  await expect
    .poll(async () => page.getByText(text).count(), { timeout: 120_000 })
    .toBeGreaterThan(previousCount);
}

async function confirmAction(page: Page, confirmButtonLabel: string): Promise<void> {
  await page
    .getByRole("dialog")
    .getByRole("button", { name: confirmButtonLabel, exact: true })
    .click();
}

async function waitForActionResponse(
  page: Page,
  options: { method: string; pathIncludes: string },
  trigger: () => Promise<void>
): Promise<void> {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === options.method &&
      new URL(response.url()).pathname.includes(options.pathIncludes),
    { timeout: 180_000 }
  );
  await trigger();
  const response = await responsePromise;
  const body = await response.text().catch(() => "");
  expect(response.ok(), body).toBe(true);
}

test.describe
  .serial("issuance redesign e2e", () => {
    test.setTimeout(360_000);
    // The app serves the previous design with the flag off (the five issuance groups in CI).
    test.skip(
      process.env.SDP_FLAG_NEW_DESIGN_ISSUANCE === "false",
      "new-design-issuance is off, so the app serves the previous Issuance design"
    );

    let fixtures: IssuanceFixtures;
    // When this worker last used the API: the end of the bootstrap, then of each test. A retry
    // runs in a new worker, so its bootstrap also outwaits the failed attempt's requests.
    let lastActivity = Date.now();

    test.beforeAll(async ({ browser }) => {
      clearIssuanceFixtures();
      fixtures = await provisionWithAdminSession(browser, (session) =>
        bootstrapLocalIssuanceFixtures({
          identity: session.identity,
          bearerToken: session.getBearerToken,
        })
      );
      lastActivity = Date.now();
    });

    test.beforeEach(async ({ page }, testInfo) => {
      await waitForFreshRateWindow(lastActivity, testInfo);
      await seedProjectCookie(page, fixtures.projectId);
    });

    test.afterEach(() => {
      lastActivity = Date.now();
    });

    test("R1. user sees every seeded token on the Issuance list", async ({ page }) => {
      await gotoIssuanceList(page);

      for (const token of Object.values(fixtures.tokens)) {
        await expect(page.locator(`[data-issuance-token-row="${token.id}"]`)).toBeVisible();
      }
      await expect(
        page.locator(`[data-issuance-token-row="${fixtures.tokens.pending.id}"]`)
      ).toContainText("Draft");
      await expect(
        page.locator(`[data-issuance-token-row="${fixtures.tokens.open.id}"]`)
      ).toContainText("Live onchain");
    });

    test("R2. user creates a stablecoin draft through the five steps", async ({ page }) => {
      const suffix = String(Date.now()).slice(-4);
      const draftName = `E2E Redesign Draft ${suffix}`;
      const draftSymbol = `RD${suffix}`;

      await gotoIssuanceList(page);
      await page.getByRole("link", { name: "Create a draft", exact: true }).first().click();
      await page.waitForURL("**/dashboard/issuance/create");

      // Classify: Continue waits for a classification and a name.
      const continueButton = page.getByRole("button", { name: "Continue", exact: true });
      await expect(continueButton).toBeDisabled();
      await page.getByRole("radio", { name: /^Stablecoin/ }).check({ force: true });
      await page.getByLabel("Name", { exact: true }).fill(draftName);
      await continueButton.click();

      // Details: a stablecoin is six decimals; the issuer is required.
      await page.getByLabel("Symbol", { exact: true }).fill(draftSymbol);
      await expect(page.getByLabel("Decimals", { exact: true })).toHaveValue("6");
      await expect(continueButton).toBeDisabled();
      await page.getByLabel("Issuer name", { exact: true }).fill("E2E Issuer Inc.");
      await continueButton.click();

      // Controls, then Permissions: every key defaults to the project's first wallet.
      await expect(page.getByText("Always on").first()).toBeVisible();
      await continueButton.click();
      await expect(continueButton).toBeEnabled({ timeout: 30_000 });
      await continueButton.click();

      // Review, then Create draft opens the new token's page.
      await expect(page.getByText(draftName).first()).toBeVisible();
      await Promise.all([
        page.waitForURL(/\/dashboard\/issuance\/(?!create)[^/?]+/, { timeout: 120_000 }),
        page.getByRole("button", { name: "Create draft", exact: true }).click(),
      ]);
      await expect(page.locator('[data-token-page="overview"]')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText("Deploy this token")).toBeVisible();

      await gotoIssuanceList(page);
      await page.getByRole("searchbox").fill(draftName);
      await expect(
        page.locator("[data-issuance-token-row]").filter({ hasText: draftName })
      ).toBeVisible({ timeout: 60_000 });
    });

    test("R3. user opens every tab of a live token", async ({ page }) => {
      const tabs: TokenTab[] = ["details", "public", "compliance", "operations", "permissions"];
      for (const tab of tabs) {
        await gotoToken(page, fixtures.tokens.allowlisted.id, tab);
      }
      await expect(page.locator('[data-token-permission="mint-authority"]')).toBeVisible();
    });

    test("R4. user deploys the seeded draft from Overview", async ({ page }) => {
      await gotoToken(page, fixtures.tokens.pending.id);
      const deployButton = page.getByRole("button", { name: "Deploy token", exact: true });
      await expect(deployButton).toBeEnabled({ timeout: 120_000 });
      const successCount = await page.getByText("Deploy transaction finalized.").count();
      // Deploy opens the previous design's dialog, which confirms the signing wallet.
      await deployButton.click();
      const deployDialog = page.getByRole("dialog");
      await expect(deployDialog.getByRole("heading", { name: "Deploy token" })).toBeVisible();
      await deployDialog.getByRole("button", { name: "Deploy token", exact: true }).click();
      await waitForToast(page, "Deploy transaction finalized.", successCount);
      await eventually(
        () => gotoToken(page, fixtures.tokens.pending.id),
        () =>
          expect(page.locator('[data-token-page="overview"]')).toContainText("Live onchain", {
            timeout: 90_000,
          })
      );
      await expect(page.getByRole("button", { name: "Deploy token", exact: true })).toHaveCount(0);
    });

    test("R5. user mints from Operations and sees the issued supply grow", async ({ page }) => {
      await gotoToken(page, fixtures.tokens.open.id, "operations");
      const before = (await recordValue(page, "Issued supply").textContent()) ?? "";

      await expect(operationButton(page, "mint")).toBeEnabled({ timeout: 120_000 });
      await operationButton(page, "mint").click();
      // Mint opens in place under the issued supply; scoped to its form, since the Operations
      // tab also explains the token's access list in a tooltip whose label reads "destinations".
      const mintForm = page.locator('[data-supply-operation="mint"]');
      await mintForm
        .getByLabel("Destination", { exact: true })
        .fill(fixtures.wallets.treasury.publicKey);
      await mintForm.getByLabel("Amount", { exact: true }).fill("10");
      // The submit reads the amount back ("Mint 10.00" and the symbol).
      await mintForm.getByRole("button", { name: /^Mint 10/ }).click();
      const successCount = await page.getByText("Mint transaction finalized.").count();
      await confirmAction(page, "Mint now");
      await waitForToast(page, "Mint transaction finalized.", successCount);

      await eventually(
        () => gotoToken(page, fixtures.tokens.open.id, "operations"),
        () => expect(recordValue(page, "Issued supply")).not.toHaveText(before, { timeout: 90_000 })
      );
      await expect(recordValue(page, "Issued supply")).toContainText("10");
    });

    test("R6. user pauses and resumes transfers from Operations", async ({ page }) => {
      await gotoToken(page, fixtures.tokens.open.id, "operations");

      await expect(operationButton(page, "pause")).toHaveText("Pause", { timeout: 120_000 });
      let successCount = await page.getByText("Pause transaction finalized.").count();
      await operationButton(page, "pause").click();
      await expect(
        page.getByRole("heading", { name: "Pause transfers for all holders?" })
      ).toBeVisible();
      await confirmAction(page, "Pause all transfers");
      await waitForToast(page, "Pause transaction finalized.", successCount);
      await expect(recordValue(page, "Transfers")).toContainText("Paused", { timeout: 120_000 });

      await expect(operationButton(page, "pause")).toHaveText("Resume", { timeout: 120_000 });
      successCount = await page.getByText("Unpause transaction finalized.").count();
      await operationButton(page, "pause").click();
      await expect(
        page.getByRole("heading", { name: "Resume transfers for all holders?" })
      ).toBeVisible();
      await confirmAction(page, "Resume transfers");
      await waitForToast(page, "Unpause transaction finalized.", successCount);
      await expect(recordValue(page, "Transfers")).toContainText("Running", { timeout: 120_000 });
    });

    test("R7. user adds and removes an approved recipient on Compliance", async ({ page }) => {
      const tokenId = fixtures.tokens.allowlisted.id;
      const address = fixtures.addresses.allowlistWallet;
      await gotoToken(page, tokenId, "compliance");

      await page.getByLabel("Address", { exact: true }).fill(address);
      await page.getByLabel("Label", { exact: true }).fill("E2E allowlist wallet");
      await waitForActionResponse(
        page,
        { method: "POST", pathIncludes: `/api/dashboard/issuance/tokens/${tokenId}/allowlist` },
        () => page.getByRole("button", { name: "Add entry", exact: true }).click()
      );
      await eventually(
        () => openLoadedComplianceList(page, tokenId),
        () =>
          expect(page.getByRole("cell", { name: address }).first()).toBeVisible({
            timeout: 90_000,
          })
      );

      await waitForActionResponse(
        page,
        { method: "DELETE", pathIncludes: `/api/dashboard/issuance/tokens/${tokenId}/allowlist/` },
        () => page.getByRole("button", { name: `Remove ${address}` }).click()
      );
      await eventually(
        () => openLoadedComplianceList(page, tokenId),
        () => expect(page.getByRole("cell", { name: address })).toHaveCount(0, { timeout: 90_000 })
      );
    });
  });
