import { expect, type Page, test } from "@playwright/test";
import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { formatDisplayLabel } from "@/lib/utils";
import { getPlaywrightAdminSession } from "../support/auth-session";
import {
  clearIssuanceFixtures,
  type IssuanceFixtures,
  readIssuanceFixtures,
} from "../support/issuance-fixtures";
import { seedProjectCookie } from "../support/local-dashboard-bootstrap";
import { bootstrapLocalIssuanceFixtures } from "../support/local-issuance-bootstrap";

// biome-ignore lint/security/noSecrets: Solana associated token program ID, not a secret.
const ASSOCIATED_TOKEN_PROGRAM_ID = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
// biome-ignore lint/security/noSecrets: Solana Token-2022 program ID, not a secret.
const TOKEN_2022_PROGRAM_ID = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

function shortValue(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 6)}...${value.slice(-6)}`;
}

async function deriveAssociatedTokenAccountAddress(owner: string, mint: string): Promise<string> {
  const encoder = getAddressEncoder();
  const [tokenAccount] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ID,
    seeds: [
      encoder.encode(address(owner)),
      encoder.encode(TOKEN_2022_PROGRAM_ID),
      encoder.encode(address(mint)),
    ],
  });

  return tokenAccount;
}

async function gotoIssuanceDashboard(page: Page): Promise<void> {
  await page.goto("/dashboard/issuance", { waitUntil: "domcontentloaded" });
  const createDraftButton = page.getByRole("button", { name: "Create draft", exact: true });
  await expect(createDraftButton)
    .toBeVisible({ timeout: 30_000 })
    .catch(async () => {
      const retryButton = page.getByRole("button", { name: "Retry", exact: true });
      if ((await retryButton.count()) > 0) {
        await retryButton.click();
      } else {
        await page.reload({ waitUntil: "domcontentloaded" });
      }
      await expect(createDraftButton).toBeVisible({ timeout: 120_000 });
    });
}

async function gotoToken(page: Page, tokenId: string): Promise<void> {
  await page.goto(`/dashboard/issuance/${tokenId}`, { waitUntil: "domcontentloaded" });
  const tokenAddressRow = page.getByTestId("overview-row-token-address");
  await expect(tokenAddressRow)
    .toBeVisible({ timeout: 30_000 })
    .catch(async () => {
      const retryButton = page.getByRole("button", { name: "Retry", exact: true });
      if ((await retryButton.count()) > 0) {
        await retryButton.click();
      } else {
        await page.reload({ waitUntil: "domcontentloaded" });
      }
      await expect(tokenAddressRow).toBeVisible({ timeout: 120_000 });
    });
}

const tabQueryParamByName = {
  Overview: null,
  Permissions: "permissions",
  Extensions: "extensions",
  Compliance: "compliance",
  Metadata: "metadata",
  Operations: "fund-management",
} as const satisfies Record<string, string | null>;

async function openTab(page: Page, name: string): Promise<void> {
  const expectedTab = tabQueryParamByName[name as keyof typeof tabQueryParamByName];
  const url = new URL(page.url());
  if (expectedTab === null) {
    url.searchParams.delete("tab");
  } else {
    url.searchParams.set("tab", expectedTab);
  }

  await page.goto(url.toString());
  await expect
    .poll(() => {
      const currentUrl = new URL(page.url());
      return currentUrl.searchParams.get("tab");
    })
    .toBe(expectedTab);

  if (name === "Overview") {
    await expect(page.getByTestId("overview-row-token-address")).toBeVisible();
  }
}

async function expectFrozenAccountsSummary(page: Page, accountCount: number): Promise<void> {
  await openTab(page, "Compliance");
  await expect(page.getByTestId("frozen-accounts-summary-card")).toContainText(
    `${accountCount} accounts`,
    { timeout: 120_000 }
  );
}

async function selectComplianceAction(page: Page, name: string): Promise<void> {
  await openTab(page, "Compliance");

  const action = page.getByRole("button", { name, exact: true });
  await expect(action)
    .toBeVisible({ timeout: 30_000 })
    .catch(async () => {
      await page.reload({ waitUntil: "domcontentloaded" });
      await openTab(page, "Compliance");
      await expect(action).toBeVisible({ timeout: 120_000 });
    });
  await action.click();
}

async function waitForToast(page: Page, text: string, previousCount = 0): Promise<void> {
  await expect
    .poll(async () => page.getByText(text).count(), { timeout: 120_000 })
    .toBeGreaterThan(previousCount);
  await expect(page.getByText(text).nth(previousCount)).toBeVisible({ timeout: 120_000 });
}

async function selectNewAuthority(page: Page, publicKey: string): Promise<void> {
  const newAuthoritySelect = page.getByLabel("New authority");
  if ((await newAuthoritySelect.locator(`option[value="${publicKey}"]`).count()) > 0) {
    await newAuthoritySelect.selectOption(publicKey);
    return;
  }

  await page.getByRole("button", { name: "Use custom address" }).click();
  await page.getByLabel("Custom authority").fill(publicKey);
}

async function waitForActionResponse(
  page: Page,
  options: { method: string; pathIncludes: string },
  trigger: () => Promise<void>
): Promise<void> {
  const responsePromise = page.waitForResponse(
    (response) => {
      const request = response.request();
      const postData = request.postData() ?? "";
      return (
        response.url().endsWith("/api/playground/execute") &&
        request.method() === "POST" &&
        postData.includes(`"method":"${options.method}"`) &&
        postData.includes(options.pathIncludes)
      );
    },
    { timeout: 180_000 }
  );

  await trigger();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const payload = (await response.json().catch(() => null)) as { ok?: boolean } | null;
  expect(payload?.ok, JSON.stringify(payload)).toBe(true);
}

async function confirmAction(page: Page, confirmButtonLabel: string): Promise<void> {
  await page.getByRole("button", { name: confirmButtonLabel, exact: true }).click();
}

async function openFundManagementAction(page: Page, action: string): Promise<void> {
  await openTab(page, "Operations");
  const row = page.getByTestId(`fund-management-row-${action}`);
  await expect(row).toBeVisible();
  const button = row.getByRole("button");
  await expect(button).toBeEnabled({ timeout: 120_000 });
  await button.click();
}

async function waitForPermissionRowValue(
  page: Page,
  rowTestId: string,
  expectedText: string
): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.reload();
        await openTab(page, "Permissions");
        return (await page.getByTestId(rowTestId).textContent()) ?? "";
      },
      { timeout: 120_000, intervals: [1_000, 2_000, 5_000] }
    )
    .toContain(expectedText);
}

async function waitForAllowlistCount(
  page: Page,
  expectedCount: number,
  options: { reload?: boolean } = {}
): Promise<void> {
  const expectedLabel = `${expectedCount} ${expectedCount === 1 ? "entries" : "entries"}`;
  if (options.reload) {
    await page.reload();
    await openTab(page, "Compliance");
    await expect(page.getByTestId("allowlist-summary-card")).toContainText(expectedLabel, {
      timeout: 120_000,
    });
    return;
  }

  await expect(page.getByTestId("allowlist-summary-card")).toContainText(expectedLabel, {
    timeout: 120_000,
  });
}

test.describe
  .serial("issuance e2e", () => {
    test.setTimeout(360_000);

    let fixtures: IssuanceFixtures;

    test.beforeAll(async ({ browser }) => {
      clearIssuanceFixtures();
      const session = await getPlaywrightAdminSession(browser);
      await bootstrapLocalIssuanceFixtures({
        identity: session.identity,
        bearerToken: session.getBearerToken,
      });
      fixtures = readIssuanceFixtures();
      await session.page.close();
    });

    test.beforeEach(async ({ page }) => {
      await seedProjectCookie(page, fixtures.projectId);
    });

    test("1. user can sign in and load the issuance dashboard", async ({ page }) => {
      await gotoIssuanceDashboard(page);

      await expect(page.getByTestId(`token-card-${fixtures.tokens.pending.id}`)).toBeVisible();
      await expect(page.getByTestId(`token-card-${fixtures.tokens.allowlisted.id}`)).toBeVisible();
      await expect(page.getByTestId(`token-card-${fixtures.tokens.authority.id}`)).toBeVisible();
      await expect(page.getByTestId(`token-card-${fixtures.tokens.open.id}`)).toBeVisible();
    });

    test("2. user can create a new pending token draft from the UI", async ({ page }) => {
      const draftSuffix = String(Date.now()).slice(-4);
      const draftName = `E2E UI Draft ${draftSuffix}`;
      const draftSymbol = `UsD${draftSuffix}`;

      await gotoIssuanceDashboard(page);
      await page.getByRole("button", { name: "Create draft" }).click();
      await page
        .getByRole("button", { name: /Stablecoin/i })
        .first()
        .click();

      // Leave the metadata URI blank: SDP hosts the metadata JSON by default,
      // so the URI field is now optional and tucked under the Advanced section.
      await page.getByLabel("Token Name").fill(draftName);
      await page.getByLabel("Symbol").fill(draftSymbol);
      await page.getByLabel("Decimals").fill("7");
      await page.getByRole("button", { name: "Continue" }).click();

      await page
        .locator("button", { hasText: "Denylist" })
        .filter({
          hasText: "Listed destinations are blocked before they can receive controlled actions.",
        })
        .click();
      await page.getByLabel("Main Signer").selectOption(fixtures.wallets.treasury.walletId);
      await page.getByRole("button", { name: "Create Stablecoin Draft" }).click();

      await expect
        .poll(async () => page.getByRole("heading", { name: draftName, exact: true }).count(), {
          timeout: 120_000,
        })
        .toBeGreaterThan(0);
      await expect(page.getByRole("heading", { name: draftName, exact: true })).toBeVisible();
      await expect(page.getByText(draftSymbol, { exact: true })).toBeVisible();
      const draftCard = page
        .locator("article")
        .filter({ has: page.getByRole("heading", { name: draftName, exact: true }) })
        .first();
      await draftCard.getByRole("link", { name: "Manage", exact: true }).click();
      await expect(page.getByTestId("overview-row-decimals")).toContainText("7");
    });

    test("3. user only sees configured extension rows on the allowlist-enabled token", async ({
      page,
    }) => {
      await gotoToken(page, fixtures.tokens.allowlisted.id);
      await openTab(page, "Extensions");

      await expect(page.getByTestId("extension-row-template")).toContainText("Stablecoin");
      await expect(page.getByTestId("extension-row-control-list")).toContainText("Allowlist");
      await expect(page.getByTestId("extension-row-mintable")).toContainText("Enabled");
      await expect(page.getByTestId("extension-row-freezable")).toContainText("Enabled");
      await expect(page.getByTestId("extension-row-default-account-state")).toContainText("Frozen");

      await expect(page.getByTestId("extension-row-transfer-fee")).toHaveCount(0);
      await expect(page.getByTestId("extension-row-scaled-ui")).toHaveCount(0);
      await expect(page.getByTestId("extension-row-transfer-hook")).toHaveCount(0);
      await expect(page.getByTestId("extension-row-interest-bearing")).toHaveCount(0);
      await expect(page.getByTestId("extension-row-non-transferable")).toHaveCount(0);
    });

    test("4. user can deploy the seeded pending token and see it become active", async ({
      page,
    }) => {
      await gotoToken(page, fixtures.tokens.pending.id);
      await openTab(page, "Operations");

      const deployRow = page.getByTestId("fund-management-row-deploy");
      await expect(deployRow.getByRole("button", { name: "Deploy" })).toBeVisible();
      await deployRow.getByRole("button", { name: "Deploy" }).click();
      await expect(
        page.getByText("This will deploy the token on-chain so operations can run.")
      ).toBeVisible();
      await page.getByRole("button", { name: "Deploy now", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Deploy token?" })).toBeVisible();
      const successCount = await page.getByText("Deploy transaction finalized.").count();
      await confirmAction(page, "Deploy now");
      await waitForToast(page, "Deploy transaction finalized.", successCount);
      await expect
        .poll(
          async () => {
            await page.reload();
            await openTab(page, "Overview");
            return (await page.getByTestId("overview-row-token-address").textContent()) ?? "";
          },
          { timeout: 120_000, intervals: [1_000, 2_000, 5_000] }
        )
        .not.toContain("Not deployed");
      await expect(page.getByRole("button", { name: "Deploy" })).toHaveCount(0);
    });

    test("5. user can update metadata on the seeded active token", async ({ page }) => {
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

    test("6. user can add and remove allowlist entries on the allowlist-enabled token", async ({
      page,
    }) => {
      await gotoToken(page, fixtures.tokens.allowlisted.id);
      await selectComplianceAction(page, "Allowlist");

      await page
        .getByRole("textbox", { name: "Address", exact: true })
        .fill(fixtures.addresses.allowlistWallet);
      await page.getByRole("textbox", { name: "Label", exact: true }).fill("E2E allowlist wallet");
      await waitForActionResponse(
        page,
        {
          method: "POST",
          pathIncludes: `/v1/issuance/tokens/${fixtures.tokens.allowlisted.id}/allowlist`,
        },
        async () => {
          await page.getByRole("button", { name: "Add allowlist entry" }).click();
        }
      );
      await waitForAllowlistCount(page, 1, { reload: true });
      await expect(page.getByText(fixtures.addresses.allowlistWallet)).toBeVisible();
      await expect(page.getByTestId("allowlist-summary-card")).toContainText("1 entries");

      const allowlistEntry = page
        .locator("div")
        .filter({ hasText: fixtures.addresses.allowlistWallet })
        .filter({ has: page.getByRole("button", { name: "Remove entry" }) })
        .first();
      await waitForActionResponse(
        page,
        {
          method: "DELETE",
          pathIncludes: `/v1/issuance/tokens/${fixtures.tokens.allowlisted.id}/allowlist/`,
        },
        async () => {
          await allowlistEntry.getByRole("button", { name: "Remove entry" }).click();
        }
      );
      await waitForAllowlistCount(page, 0, { reload: true });
      await expect(page.getByText(fixtures.addresses.allowlistWallet)).toHaveCount(0);
      await expect(page.getByTestId("allowlist-summary-card")).toContainText("0 entries");
    });

    test("7. user can update an authority including the None confirmation flow", async ({
      page,
    }) => {
      const rowTestId = "permission-row-mint-authority";
      const authorityTokenId = fixtures.tokens.authority.id;

      await gotoToken(page, authorityTokenId);
      await openTab(page, "Permissions");

      const row = page.getByTestId(rowTestId);
      if (fixtures.wallets.delegated.publicKey !== fixtures.wallets.treasury.publicKey) {
        await row.getByRole("button", { name: "Edit" }).click();
        await selectNewAuthority(page, fixtures.wallets.delegated.publicKey);
        await waitForActionResponse(
          page,
          {
            method: "POST",
            pathIncludes: `/v1/issuance/tokens/${authorityTokenId}/authority`,
          },
          async () => {
            await page.getByRole("button", { name: "Save authority" }).click();
          }
        );
        await waitForPermissionRowValue(
          page,
          rowTestId,
          shortValue(fixtures.wallets.delegated.publicKey)
        );
      }

      const refreshedRow = page.getByTestId(rowTestId);
      await refreshedRow.getByRole("button", { name: "Edit" }).click();
      await page.getByLabel("New authority").selectOption({ label: "None" });
      await page.getByRole("button", { name: "Save authority" }).click();

      await expect(
        page.getByRole("heading", { name: "Set Mint Authority to None?" })
      ).toBeVisible();
      await waitForActionResponse(
        page,
        {
          method: "POST",
          pathIncludes: `/v1/issuance/tokens/${authorityTokenId}/authority`,
        },
        async () => {
          await page.getByRole("button", { name: "Yes, set to None" }).click();
        }
      );
      await waitForPermissionRowValue(page, rowTestId, "None");
    });

    test("8. user sees denylist controls on the open stablecoin token", async ({ page }) => {
      await gotoToken(page, fixtures.tokens.open.id);
      await selectComplianceAction(page, "Denylist");

      await expect(page.getByRole("button", { name: "Denylist", exact: true })).toBeVisible();
      await expect(
        page.getByText("Manage the blocked destination addresses for this token.")
      ).toBeVisible();
      await page.getByRole("button", { name: "Freeze", exact: true }).click();
      await expect(
        page.getByText(
          "Need to restrict a wallet before it has a token account? Add it to the denylist first."
        )
      ).toBeVisible();
      await expect(page.getByTestId("allowlist-summary-card")).toContainText("Denylist Entries");
    });

    test("9. user can mint and burn tokens with supply and transactions updating", async ({
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
      const openMintAddress = fixtures.tokens.open.mintAddress;
      if (!openMintAddress) {
        throw new Error("Open issuance fixture is missing a mint address");
      }
      const treasuryTokenAccount = await deriveAssociatedTokenAccountAddress(
        fixtures.wallets.treasury.publicKey,
        openMintAddress
      );
      await page.getByLabel("Source").fill(treasuryTokenAccount);
      await page.getByLabel("Amount").fill("3");
      await page.getByRole("button", { name: "Burn tokens" }).click();
      successCount = await page.getByText("Burn transaction finalized.").count();
      await confirmAction(page, "Burn now");
      await waitForToast(page, "Burn transaction finalized.", successCount);
      await page.reload();

      await openTab(page, "Overview");
      await expect(page.getByTestId("overview-row-supply")).toContainText("7");

      await openTab(page, "Operations");
      await expect(page.getByTestId("fund-management-row-mint")).toBeVisible();
      await expect(page.getByTestId("fund-management-row-burn")).toBeVisible();
    });

    test("10. user can freeze and unfreeze using a wallet address in the UI", async ({ page }) => {
      await gotoToken(page, fixtures.tokens.open.id);

      await openFundManagementAction(page, "mint");
      await page.getByLabel("Destination").fill(fixtures.addresses.freezeWallet);
      await page.getByLabel("Amount").fill("1");
      await page.getByRole("button", { name: "Mint tokens" }).click();
      let successCount = await page.getByText("Mint transaction finalized.").count();
      await confirmAction(page, "Mint now");
      await waitForToast(page, "Mint transaction finalized.", successCount);

      await selectComplianceAction(page, "Freeze");
      await page.getByLabel("Wallet Address").fill(fixtures.addresses.freezeWallet);
      await page.getByLabel("Reason (freeze only)").fill("Playwright freeze validation");
      await page.getByRole("button", { name: "Freeze account", exact: true }).click();
      successCount = await page.getByText("Freeze transaction finalized.").count();
      await confirmAction(page, "Freeze now");
      await waitForToast(page, "Freeze transaction finalized.", successCount);
      await expectFrozenAccountsSummary(page, 1);

      await selectComplianceAction(page, "Freeze");
      await page.getByLabel("Wallet Address").fill(fixtures.addresses.freezeWallet);
      await page.getByRole("button", { name: "Unfreeze account", exact: true }).click();
      successCount = await page.getByText("Unfreeze transaction finalized.").count();
      await confirmAction(page, "Unfreeze now");
      await waitForToast(page, "Unfreeze transaction finalized.", successCount);
      await expectFrozenAccountsSummary(page, 0);
    });

    test("11. user sees the token ID row on the detail header and can copy it", async ({
      page,
    }) => {
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await gotoToken(page, fixtures.tokens.open.id);

      const tokenIdRow = page.getByTestId("token-id-row");
      await expect(tokenIdRow).toBeVisible();
      await expect(tokenIdRow).toContainText("Token ID:");
      await expect(tokenIdRow).toContainText(fixtures.tokens.open.id);

      const successCount = await page.getByText("Token ID copied").count();
      await tokenIdRow.getByRole("button", { name: "Copy token ID" }).click();
      await waitForToast(page, "Token ID copied", successCount);

      const clipboardValue = await page.evaluate(() => navigator.clipboard.readText());
      expect(clipboardValue).toBe(fixtures.tokens.open.id);
    });

    test("12. user sees a populated tokenId dropdown in the API playground", async ({ page }) => {
      // biome-ignore lint/security/noSecrets: dashboard URL with playground query params, not a secret
      await page.goto("/dashboard/issuance?tab=playground&endpoint=get-token");

      const tokenIdSelect = page.getByLabel("{tokenId}");
      await expect(tokenIdSelect).toBeVisible();
      await expect(tokenIdSelect).toHaveJSProperty("tagName", "SELECT");

      const optionValues = await tokenIdSelect
        .locator("option")
        .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
      expect(optionValues).toContain(fixtures.tokens.pending.id);
      expect(optionValues).toContain(fixtures.tokens.allowlisted.id);
      expect(optionValues).toContain(fixtures.tokens.authority.id);
      expect(optionValues).toContain(fixtures.tokens.open.id);

      const initialValue = await tokenIdSelect.inputValue();
      expect(initialValue).not.toBe("");
      expect(optionValues).toContain(initialValue);

      await tokenIdSelect.selectOption(fixtures.tokens.open.id);
      await expect(tokenIdSelect).toHaveValue(fixtures.tokens.open.id);
    });

    test("13. user can pause and unpause the token from compliance controls", async ({ page }) => {
      await gotoToken(page, fixtures.tokens.open.id);

      await selectComplianceAction(page, "Pause");
      await page.getByRole("button", { name: "Pause token", exact: true }).click();
      let successCount = await page.getByText("Pause transaction finalized.").count();
      await confirmAction(page, "Pause now");
      await waitForToast(page, "Pause transaction finalized.", successCount);
      await expect(page.getByText("Token is paused")).toBeVisible();

      await selectComplianceAction(page, "Pause");
      await page.getByRole("button", { name: "Unpause token", exact: true }).first().click();
      successCount = await page.getByText("Unpause transaction finalized.").count();
      await confirmAction(page, "Unpause now");
      await waitForToast(page, "Unpause transaction finalized.", successCount);
      await expect(page.getByText("Token is paused")).toHaveCount(0);
    });
  });

test.describe("formatDisplayLabel", () => {
  test("single word", () => {
    expect(formatDisplayLabel("active")).toBe("Active");
  });

  test("snake_case", () => {
    expect(formatDisplayLabel("force_burn")).toBe("Force Burn");
    expect(formatDisplayLabel("update_authority")).toBe("Update Authority");
  });

  test("kebab-case", () => {
    expect(formatDisplayLabel("tokenized-security")).toBe("Tokenized Security");
  });

  test("RWA override", () => {
    expect(formatDisplayLabel("rwa")).toBe("RWA");
  });
});
