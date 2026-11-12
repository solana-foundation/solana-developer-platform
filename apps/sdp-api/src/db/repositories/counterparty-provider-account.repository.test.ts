import { afterAll, assert, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
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

  describe("customer link status order", () => {
    const at = (seconds: number) => new Date(Date.UTC(2026, 10, 4, 12, 0, seconds)).toISOString();

    async function linkHercle(externalId: string, reference: string) {
      const counterparty = await seedCounterparty(externalId);
      const scope = {
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        provider: "hercle" as const,
      };
      await repository.upsertProviderAccount({ ...scope, providerCustomerReference: reference });
      const record = (
        providerStatus: string | null,
        observedAt: string,
        winsTie = true,
        preserves: string[] = []
      ) =>
        repository.recordCustomerLinkStatus({
          ...scope,
          observation: { providerStatus, observedAt, winsTie, preserves },
        });
      const read = async () => (await repository.getProviderAccount(scope))?.provider_status;
      return { counterparty, scope, record, read };
    }

    it("keeps the newest report and refuses an older one", async () => {
      const link = await linkHercle("cpacc_order_newest", "acct_order_newest");

      expect(await link.record("pending", at(10))).toBe("recorded");
      expect(await link.record("approved", at(20))).toBe("recorded");
      expect(await link.record("pending", at(15))).toBe("stale");

      expect(await link.read()).toBe("approved");
      expect((await repository.getProviderAccount(link.scope))?.provider_status_observed_at).toBe(
        at(20)
      );
    });

    it("settles a same-instant tie on the report that wins it", async () => {
      const link = await linkHercle("cpacc_order_tie", "acct_order_tie");
      await link.record("approved", at(10), false);

      expect(await link.record("approved", at(10), false)).toBe("stale");
      expect(await link.record("rejected", at(10), true)).toBe("recorded");
      // A duplicate of the stored report changes nothing.
      expect(await link.record("rejected", at(10), true)).toBe("stale");
      expect(await link.record("approved", at(10), false)).toBe("stale");
      expect(await link.read()).toBe("rejected");
    });

    it("leaves a status the report preserves, however new the report", async () => {
      const link = await linkHercle("cpacc_order_preserve", "acct_order_preserve");
      await link.record("suspended", at(10));

      expect(await link.record("approved", at(50), false, ["suspended"])).toBe("stale");
      expect(await link.record(null, at(50), true, ["suspended"])).toBe("stale");
      expect(await link.record("approved", at(50), false)).toBe("recorded");
      expect(await link.read()).toBe("approved");
    });

    it("answers missing for a link that is not active in scope", async () => {
      const link = await linkHercle("cpacc_order_missing", "acct_order_missing");
      await getDb(env)
        .prepare(
          "UPDATE counterparty_provider_accounts SET status = 'archived' WHERE counterparty_id = ?"
        )
        .bind(link.counterparty.id)
        .run();

      expect(await link.record("approved", at(10))).toBe("missing");
      expect(
        await repository.recordCustomerLinkStatus({
          ...link.scope,
          organizationId: "org_not_owned",
          observation: {
            providerStatus: "approved",
            observedAt: at(10),
            winsTie: true,
            preserves: [],
          },
        })
      ).toBe("missing");
    });

    it("finds the one active link a provider reference names, with its project's environment", async () => {
      const link = await linkHercle("cpacc_order_find", "acct_order_find");

      expect(
        await repository.findCustomerLinkByProviderReference({
          provider: "hercle",
          providerCustomerReference: "acct_order_find",
        })
      ).toEqual({
        link: expect.objectContaining({
          counterparty_id: link.counterparty.id,
          organization_id: TEST_ORG.id,
          project_id: TEST_PROJECT_ID,
        }),
        environment: "sandbox",
      });
      expect(
        await repository.findCustomerLinkByProviderReference({
          provider: "moonpay",
          providerCustomerReference: "acct_order_find",
        })
      ).toBeNull();

      await getDb(env)
        .prepare("UPDATE counterparties SET status = 'archived' WHERE id = ?")
        .bind(link.counterparty.id)
        .run();
      expect(
        await repository.findCustomerLinkByProviderReference({
          provider: "hercle",
          providerCustomerReference: "acct_order_find",
        })
      ).toBeNull();
    });
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
