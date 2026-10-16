import { afterAll, assert, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { createPostgresCounterpartiesRepository } from "./counterparty.repository.postgres";
import {
  type CounterpartyProviderAccountsRepository,
  counterpartyProviderAccountUuid,
  generateCounterpartyProviderAccountId,
} from "./counterparty-provider-account.repository";
import { createPostgresCounterpartyProviderAccountsRepository } from "./counterparty-provider-account.repository.postgres";

const TEST_PROJECT_ID = "prj_cpacc_repo_test";

describe("CounterpartyProviderAccountsRepository (postgres)", () => {
  let repository: CounterpartyProviderAccountsRepository;

  beforeAll(async () => {
    await seedTestDatabase(env);
  });

  afterAll(async () => {
    await seedTestDatabase(env);
  });

  beforeEach(async () => {
    const db = getDb(env);
    await db.prepare("DELETE FROM counterparty_provider_accounts").run();
    await db.prepare("DELETE FROM counterparties").run();
    await db.prepare("DELETE FROM projects").run();
    await db
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    await db
      .prepare(
        "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
      )
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [],
      ids: { sandbox: TEST_PROJECT_ID, production: `${TEST_PROJECT_ID}_production` },
    });
    repository = createPostgresCounterpartyProviderAccountsRepository(db);
  });

  /**
   * Seeds one counterparty under the repository test scope.
   *
   * @param externalId - Stable fixture external id.
   * @returns The created counterparty row.
   */
  async function seedCounterparty(externalId: string) {
    const counterparty = await createPostgresCounterpartiesRepository(
      getDb(env)
    ).createCounterparty({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      externalId,
      entityType: "individual",
      displayName: "Ada Lovelace",
      providerData: {},
      createdBy: TEST_USER.id,
    });
    assert(counterparty);
    return counterparty;
  }

  /**
   * Inserts a stored Lightspark row as history: nothing writes rows for a
   * retired provider, so the fixture goes straight to the table.
   *
   * @param input - Parent counterparty, row kind, status and payout corridor.
   * @returns The inserted row id.
   */
  async function seedStoredAccount(input: {
    counterpartyId: string;
    kind: "customer_link" | "payout_account";
    status: "active" | "archived";
    corridor?: { fiatCurrency: string; destinationCountry: string; paymentRail: string };
  }): Promise<string> {
    const id = generateCounterpartyProviderAccountId();
    await getDb(env)
      .prepare(
        `INSERT INTO counterparty_provider_accounts (
           id, organization_id, project_id, counterparty_id, provider,
           provider_customer_reference, kind, external_account_reference, fiat_currency,
           destination_country, payment_rail, status, metadata
         ) VALUES (?, ?, ?, ?, 'lightspark', 'Customer:stored', ?, ?, ?, ?, ?, ?, '{}'::jsonb)`
      )
      .bind(
        id,
        TEST_ORG.id,
        TEST_PROJECT_ID,
        input.counterpartyId,
        input.kind,
        input.corridor === undefined ? null : `ExternalAccount:${id}`,
        input.corridor === undefined ? null : input.corridor.fiatCurrency,
        input.corridor === undefined ? null : input.corridor.destinationCountry,
        input.corridor === undefined ? null : input.corridor.paymentRail,
        input.status
      )
      .run();
    return id;
  }

  it("lists a retired provider's stored rows with parent, corridor and tenant filters", async () => {
    const counterparty = await seedCounterparty("cpacc_list_provider_accounts");
    const otherCounterparty = await seedCounterparty("cpacc_list_provider_accounts_other");
    const customer = await seedStoredAccount({
      counterpartyId: counterparty.id,
      kind: "customer_link",
      status: "active",
    });
    const usd = await seedStoredAccount({
      counterpartyId: counterparty.id,
      kind: "payout_account",
      status: "active",
      corridor: { fiatCurrency: "USD", destinationCountry: "US", paymentRail: "ACH" },
    });
    const gbp = await seedStoredAccount({
      counterpartyId: counterparty.id,
      kind: "payout_account",
      status: "archived",
      corridor: { fiatCurrency: "GBP", destinationCountry: "GB", paymentRail: "FPS" },
    });

    expect(
      await repository.listProviderAccounts({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
      })
    ).toEqual([
      expect.objectContaining({ id: customer, kind: "customer_link", provider: "lightspark" }),
      expect.objectContaining({ id: usd, kind: "payout_account", status: "active" }),
      expect.objectContaining({ id: gbp, status: "archived" }),
    ]);
    expect(
      await repository.listProviderAccounts({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        fiatCurrency: "USD",
        destinationCountry: "US",
      })
    ).toEqual([
      expect.objectContaining({ id: customer, kind: "customer_link" }),
      expect.objectContaining({ id: usd }),
    ]);
    expect(
      await repository.listProviderAccounts({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: otherCounterparty.id,
      })
    ).toEqual([]);
    expect(
      await repository.listProviderAccounts({
        organizationId: "org_not_owned",
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
      })
    ).toEqual([]);
  });
});

describe("counterpartyProviderAccountUuid", () => {
  it("strips the prefix from a generated row id", () => {
    const id = generateCounterpartyProviderAccountId();
    expect(counterpartyProviderAccountUuid(id)).toBe(
      id.slice("counterparty_provider_account_".length)
    );
  });

  it("rejects ids that are not prefixed uuids", () => {
    expect(() => counterpartyProviderAccountUuid("cpa_archived_cpty_123")).toThrow();
    expect(() =>
      counterpartyProviderAccountUuid("counterparty_provider_account_not-a-uuid")
    ).toThrow();
    expect(() =>
      counterpartyProviderAccountUuid("other_prefix_2a9c8a29-5030-456d-87c2-7f6cc2ee6bf3")
    ).toThrow();
  });
});
