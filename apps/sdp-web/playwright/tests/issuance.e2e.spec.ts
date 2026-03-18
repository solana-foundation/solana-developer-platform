import { type Page, expect, test } from "@playwright/test";
import { type IssuanceFixtures, readIssuanceFixtures } from "../support/issuance-fixtures";

function shortValue(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 6)}...${value.slice(-6)}`;
}

async function gotoIssuanceDashboard(page: Page): Promise<void> {
  await page.goto("/dashboard/issuance");
  await expect(page.getByRole("button", { name: "Create token" })).toBeVisible();
}

async function gotoToken(page: Page, tokenId: string): Promise<void> {
  await page.goto(`/dashboard/issuance/${tokenId}`);
  await expect(page.getByTestId("permission-row-mint-authority")).toBeVisible();
}

async function openTab(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name, exact: true }).click();
}

async function waitForToast(page: Page, text: string, previousCount = 0): Promise<void> {
  await expect
    .poll(async () => page.getByText(text).count(), { timeout: 120_000 })
    .toBeGreaterThan(previousCount);
  await expect(page.getByText(text).nth(previousCount)).toBeVisible({ timeout: 120_000 });
}

async function confirmAction(page: Page, confirmButtonLabel: string): Promise<void> {
  await page.getByRole("button", { name: confirmButtonLabel, exact: true }).click();
}

async function waitForTokenPageAction(page: Page, tokenId: string): Promise<void> {
  await page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes(`/dashboard/issuance/${tokenId}`) &&
      response.status() === 200,
    { timeout: 120_000 }
  );
}

async function openFundManagementAction(page: Page, action: string): Promise<void> {
  await openTab(page, "Fund Management");
  const row = page.getByTestId(`fund-management-row-${action}`);
  await expect(row).toBeVisible();
  await row.getByRole("button").click();
}

test.describe
  .serial("issuance e2e", () => {
    let fixtures: IssuanceFixtures;

    test.beforeAll(() => {
      fixtures = readIssuanceFixtures();
    });

    test("1. user can sign in and load the issuance dashboard", async ({ page }) => {
      await gotoIssuanceDashboard(page);

      await expect(page.getByTestId(`token-card-${fixtures.tokens.pending.id}`)).toBeVisible();
      await expect(page.getByTestId(`token-card-${fixtures.tokens.allowlisted.id}`)).toBeVisible();
      await expect(page.getByTestId(`token-card-${fixtures.tokens.open.id}`)).toBeVisible();
    });

    test("2. user can create a new pending token draft from the UI", async ({ page }) => {
      const draftSuffix = String(Date.now()).slice(-4);
      const draftName = `E2E UI Draft ${draftSuffix}`;
      const draftSymbol = `E2E${draftSuffix}`;

      await gotoIssuanceDashboard(page);
      await page.getByRole("button", { name: "Create token" }).click();
      await page
        .getByRole("button", { name: /Stablecoin/i })
        .first()
        .click();

      await page
        .getByLabel("Metadata URI")
        .fill(`https://example.com/metadata/e2e-ui-draft-${draftSuffix}.json`);
      await page.getByLabel("Token Name").fill(draftName);
      await page.getByLabel("Symbol").fill(draftSymbol);
      await page.getByRole("button", { name: "Continue" }).click();

      await page
        .locator("button", { hasText: "Disabled" })
        .filter({ hasText: "This token will not use an allowlist." })
        .click();
      await page.getByLabel("Main Signer").selectOption(fixtures.wallets.treasury.walletId);
      await page.getByRole("button", { name: "Create Stablecoin" }).click();

      await waitForToast(page, `Token ${draftName} created successfully.`);
      await expect(page.getByRole("heading", { name: draftName, exact: true })).toBeVisible();
    });

    test("3. user can deploy the seeded pending token and see it become active", async ({
      page,
    }) => {
      await gotoToken(page, fixtures.tokens.pending.id);

      await expect(page.getByRole("button", { name: "Deploy" })).toBeVisible();
      await page.getByRole("button", { name: "Deploy" }).click();
      await Promise.all([
        waitForTokenPageAction(page, fixtures.tokens.pending.id),
        confirmAction(page, "Deploy now"),
      ]);
      await page.reload();

      await openTab(page, "Overview");
      await expect(page.getByTestId("overview-row-token-address")).not.toContainText(
        "Not deployed"
      );
      await expect(page.getByRole("button", { name: "Deploy" })).toHaveCount(0);
    });

    test("4. user can update metadata on the seeded active token", async ({ page }) => {
      const updatedName = "E2E Allowlist Stable Updated";
      const updatedDescription = "Updated by Playwright issuance e2e.";
      const updatedUri = "https://example.com/metadata/e2e-allowlisted-stable-updated.json";
      const updatedImageUrl = "https://example.com/assets/e2e-allowlisted-stable-updated.png";

      await gotoToken(page, fixtures.tokens.allowlisted.id);
      await openTab(page, "Metadata");

      await page.getByLabel("Name").fill(updatedName);
      await page.getByLabel("Description").fill(updatedDescription);
      await page.getByLabel("URI").fill(updatedUri);
      await page.getByLabel("Image URL").fill(updatedImageUrl);
      const successCount = await page.getByText("Transaction finalized successfully.").count();
      await page.getByRole("button", { name: "Save metadata" }).click();
      await waitForToast(page, "Transaction finalized successfully.", successCount);
      await page.reload();

      await expect(page.getByRole("heading", { name: updatedName })).toBeVisible();
      await openTab(page, "Metadata");
      await expect(page.getByLabel("Description")).toHaveValue(updatedDescription);
      await expect(page.getByLabel("URI")).toHaveValue(updatedUri);
      await expect(page.getByLabel("Image URL")).toHaveValue(updatedImageUrl);
    });

    test("5. user can update an authority including the None confirmation flow", async ({
      page,
    }) => {
      await gotoToken(page, fixtures.tokens.allowlisted.id);

      const row = page.getByTestId("permission-row-permanent-delegate");
      await row.getByRole("button", { name: "Edit" }).click();
      await page.getByLabel("New authority").selectOption(fixtures.wallets.delegated.publicKey);
      let successCount = await page.getByText("Permanent Delegate Authority updated.").count();
      await page.getByRole("button", { name: "Save authority" }).click();
      await waitForToast(page, "Permanent Delegate Authority updated.", successCount);
      await expect(row).toContainText(shortValue(fixtures.wallets.delegated.publicKey));

      await row.getByRole("button", { name: "Edit" }).click();
      await page.getByLabel("New authority").selectOption({ label: "None" });
      await page.getByRole("button", { name: "Save authority" }).click();

      await expect(
        page.getByRole("heading", { name: "Set Permanent Delegate Authority to None?" })
      ).toBeVisible();
      successCount = await page.getByText("Permanent Delegate Authority updated.").count();
      await page.getByRole("button", { name: "Yes, set to None" }).click();
      await waitForToast(page, "Permanent Delegate Authority updated.", successCount);
      await expect(row).toContainText("None");
    });

    test("6. user can add and remove allowlist entries on the allowlist-enabled token", async ({
      page,
    }) => {
      await gotoToken(page, fixtures.tokens.allowlisted.id);
      await openTab(page, "Compliance");

      await page
        .getByRole("textbox", { name: "Address", exact: true })
        .fill(fixtures.addresses.allowlistWallet);
      await page.getByRole("textbox", { name: "Label", exact: true }).fill("E2E allowlist wallet");
      let successCount = await page.getByText("Transaction finalized successfully.").count();
      await page.getByRole("button", { name: "Add allowlist entry" }).click();
      await waitForToast(page, "Transaction finalized successfully.", successCount);
      await expect(page.getByText(fixtures.addresses.allowlistWallet)).toBeVisible();
      await expect(page.getByTestId("allowlist-summary-card")).toContainText("1 entries");

      const allowlistEntry = page
        .locator("div")
        .filter({ hasText: fixtures.addresses.allowlistWallet })
        .filter({ has: page.getByRole("button", { name: "Remove entry" }) })
        .first();
      successCount = await page.getByText("Transaction finalized successfully.").count();
      await allowlistEntry.getByRole("button", { name: "Remove entry" }).click();
      await waitForToast(page, "Transaction finalized successfully.", successCount);
      await expect(page.getByText(fixtures.addresses.allowlistWallet)).toHaveCount(0);
      await expect(page.getByTestId("allowlist-summary-card")).toContainText("0 entries");
    });

    test("7. user does not see allowlist management for the non-allowlist token", async ({
      page,
    }) => {
      await gotoToken(page, fixtures.tokens.open.id);

      await openTab(page, "Extensions");
      await expect(page.getByTestId("extension-row-allowlist")).toHaveCount(0);

      await openTab(page, "Compliance");
      await expect(page.getByRole("button", { name: "Allowlist", exact: true })).toHaveCount(0);
      await expect(page.getByTestId("allowlist-summary-card")).toHaveCount(0);
      await expect(page.getByTestId("frozen-accounts-summary-card")).toBeVisible();
    });

    test("8. user can mint and burn tokens with supply and transactions updating", async ({
      page,
    }) => {
      await gotoToken(page, fixtures.tokens.open.id);

      await openFundManagementAction(page, "mint");
      await page.getByLabel("Destination").fill(fixtures.wallets.treasury.publicKey);
      await page.getByLabel("Amount").fill("10");
      await page.getByRole("button", { name: "Mint tokens" }).click();
      let successCount = await page.getByText("Mint transaction finalized.").count();
      await confirmAction(page, "Mint now");
      await waitForToast(page, "Mint transaction finalized.", successCount);
      await page.reload();

      await openTab(page, "Overview");
      await expect(page.getByTestId("overview-row-supply")).toContainText("10");

      await openFundManagementAction(page, "burn");
      await page.getByLabel("Source").fill(fixtures.wallets.treasury.publicKey);
      await page.getByLabel("Amount").fill("3");
      await page.getByRole("button", { name: "Burn tokens" }).click();
      successCount = await page.getByText("Burn transaction finalized.").count();
      await confirmAction(page, "Burn now");
      await waitForToast(page, "Burn transaction finalized.", successCount);
      await page.reload();

      await openTab(page, "Overview");
      await expect(page.getByTestId("overview-row-supply")).toContainText("7");

      await openTab(page, "Fund Management");
      await expect(page.getByRole("cell", { name: "mint" })).toBeVisible();
      await expect(page.getByRole("cell", { name: "burn" })).toBeVisible();
    });

    test("9. user can freeze and unfreeze using a wallet address in the UI", async ({ page }) => {
      await gotoToken(page, fixtures.tokens.open.id);

      await openFundManagementAction(page, "mint");
      await page.getByLabel("Destination").fill(fixtures.addresses.freezeWallet);
      await page.getByLabel("Amount").fill("1");
      await page.getByRole("button", { name: "Mint tokens" }).click();
      let successCount = await page.getByText("Mint transaction finalized.").count();
      await confirmAction(page, "Mint now");
      await waitForToast(page, "Mint transaction finalized.", successCount);

      await openTab(page, "Compliance");
      await page.getByRole("button", { name: "Freeze", exact: true }).click();
      await page.getByLabel("Wallet Address").fill(fixtures.addresses.freezeWallet);
      await page.getByLabel("Reason (freeze only)").fill("Playwright freeze validation");
      await page.getByRole("button", { name: "Freeze account", exact: true }).click();
      successCount = await page.getByText("Freeze transaction finalized.").count();
      await confirmAction(page, "Freeze now");
      await waitForToast(page, "Freeze transaction finalized.", successCount);
      await page.reload();

      await openTab(page, "Compliance");
      await expect(page.getByTestId("frozen-accounts-summary-card")).toContainText("1 accounts");

      await page.getByRole("button", { name: "Freeze", exact: true }).click();
      await page.getByLabel("Wallet Address").fill(fixtures.addresses.freezeWallet);
      await page.getByRole("button", { name: "Unfreeze account", exact: true }).click();
      successCount = await page.getByText("Unfreeze transaction finalized.").count();
      await confirmAction(page, "Unfreeze now");
      await waitForToast(page, "Unfreeze transaction finalized.", successCount);
      await page.reload();

      await openTab(page, "Compliance");
      await expect(page.getByTestId("frozen-accounts-summary-card")).toContainText("0 accounts");
    });

    test("10. user can pause and unpause the token from compliance controls", async ({ page }) => {
      await gotoToken(page, fixtures.tokens.open.id);
      await openTab(page, "Compliance");

      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await page.getByRole("button", { name: "Pause token", exact: true }).click();
      let successCount = await page.getByText("Pause transaction finalized.").count();
      await confirmAction(page, "Pause now");
      await waitForToast(page, "Pause transaction finalized.", successCount);
      await expect(page.getByText("Token is paused")).toBeVisible();

      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await page.getByRole("button", { name: "Unpause token", exact: true }).first().click();
      successCount = await page.getByText("Unpause transaction finalized.").count();
      await confirmAction(page, "Unpause now");
      await waitForToast(page, "Unpause transaction finalized.", successCount);
      await expect(page.getByText("Token is paused")).toHaveCount(0);
    });
  });
