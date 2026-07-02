import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { createPostgresCounterpartiesRepository } from "./counterparty.repository.postgres";
import type { CounterpartyAccountsRepository } from "./counterparty-account.repository";
import { createPostgresCounterpartyAccountsRepository } from "./counterparty-account.repository.postgres";

const TEST_PROJECT_ID = "prj_cpta_repo_test";

describe("CounterpartyAccountsRepository (postgres)", () => {
  let repo: CounterpartyAccountsRepository;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await clearTestDatabase(env as Parameters<typeof clearTestDatabase>[0]);
  });

  beforeEach(async () => {
    const db = getDb(env);
    await db.prepare("DELETE FROM counterparty_accounts").run();
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

    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Test Project', 'test-project', 'sandbox', 'active', ?)`
      )
      .bind(TEST_PROJECT_ID, TEST_ORG.id, TEST_USER.id)
      .run();

    repo = createPostgresCounterpartyAccountsRepository(db);
  });

  async function seedCounterparty(externalId: string | null = null) {
    const counterpartiesRepo = createPostgresCounterpartiesRepository(getDb(env));
    const row = await counterpartiesRepo.createCounterparty({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      externalId,
      entityType: "individual",
      displayName: "Acme Recipient",
      email: "acme@example.com",
      identity: { firstName: "Acme" },
      createdBy: TEST_USER.id,
    });
    if (!row) {
      throw new Error("failed to seed counterparty");
    }
    return row;
  }

  describe("createCounterpartyAccount", () => {
    it("inserts and returns the row with generated id", async () => {
      const counterparty = await seedCounterparty();

      const row = await repo.createCounterpartyAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        accountKind: "crypto_wallet",
        label: "Alice's Solana",
        details: { network: "solana", address: "7xK...Pump" },
        providerAccountData: { provider: "grid", gridExternalAccountId: "ext_abc" },
      });

      expect(row).not.toBeNull();
      expect(row?.id).toMatch(/^counterparty_account_/);
      expect(row?.counterparty_id).toBe(counterparty.id);
      expect(row?.account_kind).toBe("crypto_wallet");
      expect(row?.label).toBe("Alice's Solana");
      expect(row?.details).toMatchObject({ network: "solana", address: "7xK...Pump" });
      expect(row?.provider_account_data).toMatchObject({ provider: "grid" });
      expect(row?.status).toBe("active");
    });

    it("defaults details and provider_account_data to {} when omitted", async () => {
      const counterparty = await seedCounterparty();

      const row = await repo.createCounterpartyAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        accountKind: "bank_account",
      });

      expect(row?.label).toBeNull();
      expect(row?.details).toEqual({});
      expect(row?.provider_account_data).toEqual({});
    });
  });

  describe("getCounterpartyAccountById", () => {
    it("returns the row when active and counterparty matches", async () => {
      const counterparty = await seedCounterparty();
      const account = await repo.createCounterpartyAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        accountKind: "crypto_wallet",
        label: "Alice's Solana",
      });

      const row = await repo.getCounterpartyAccountById({
        counterpartyAccountId: account?.id ?? "",
        counterpartyId: counterparty.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
      });
      expect(row?.id).toBe(account?.id);
      expect(row?.label).toBe("Alice's Solana");
    });

    it("returns null when counterpartyId does not own the account (cross-counterparty defense)", async () => {
      const cptyA = await seedCounterparty("ext_A");
      const cptyB = await seedCounterparty("ext_B");
      const account = await repo.createCounterpartyAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: cptyA.id,
        accountKind: "crypto_wallet",
      });

      const result = await repo.getCounterpartyAccountById({
        counterpartyAccountId: account?.id ?? "",
        counterpartyId: cptyB.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
      });
      expect(result).toBeNull();
    });

    it("returns null for archived rows", async () => {
      const counterparty = await seedCounterparty();
      const account = await repo.createCounterpartyAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        accountKind: "bank_account",
      });

      await repo.archiveCounterpartyAccount({
        counterpartyAccountId: account?.id ?? "",
        counterpartyId: counterparty.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
      });

      const result = await repo.getCounterpartyAccountById({
        counterpartyAccountId: account?.id ?? "",
        counterpartyId: counterparty.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
      });
      expect(result).toBeNull();
    });

    it("returns null when org or project doesn't match (tenancy guard)", async () => {
      const counterparty = await seedCounterparty();
      const account = await repo.createCounterpartyAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        accountKind: "bank_account",
      });

      const wrongProject = await repo.getCounterpartyAccountById({
        counterpartyAccountId: account?.id ?? "",
        counterpartyId: counterparty.id,
        organizationId: TEST_ORG.id,
        projectId: "prj_does_not_exist",
      });
      expect(wrongProject).toBeNull();
    });
  });

  describe("listCounterpartyAccountsByCounterparty", () => {
    it("returns only active accounts by default, newest first", async () => {
      const counterparty = await seedCounterparty();

      const first = await repo.createCounterpartyAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        accountKind: "bank_account",
        label: "first",
      });
      const second = await repo.createCounterpartyAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        accountKind: "crypto_wallet",
        label: "second",
      });
      await repo.archiveCounterpartyAccount({
        counterpartyAccountId: first?.id ?? "",
        counterpartyId: counterparty.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
      });

      const { rows, total } = await repo.listCounterpartyAccountsByCounterparty({
        counterpartyId: counterparty.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        limit: 50,
        offset: 0,
      });

      expect(total).toBe(1);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(second?.id);
    });

    it("includes archived rows when includeArchived is true", async () => {
      const counterparty = await seedCounterparty();
      const first = await repo.createCounterpartyAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        accountKind: "bank_account",
      });
      await repo.archiveCounterpartyAccount({
        counterpartyAccountId: first?.id ?? "",
        counterpartyId: counterparty.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
      });

      const { total } = await repo.listCounterpartyAccountsByCounterparty({
        counterpartyId: counterparty.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        includeArchived: true,
        limit: 50,
        offset: 0,
      });
      expect(total).toBe(1);
    });

    it("filters by accountKind when provided", async () => {
      const counterparty = await seedCounterparty();
      await repo.createCounterpartyAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        accountKind: "bank_account",
      });
      await repo.createCounterpartyAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        accountKind: "crypto_wallet",
      });

      const { rows, total } = await repo.listCounterpartyAccountsByCounterparty({
        counterpartyId: counterparty.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        accountKind: "crypto_wallet",
        limit: 50,
        offset: 0,
      });

      expect(total).toBe(1);
      expect(rows[0].account_kind).toBe("crypto_wallet");
    });

    it("scopes by counterpartyId — accounts on a sibling counterparty are excluded", async () => {
      const cptyA = await seedCounterparty("ext_A");
      const cptyB = await seedCounterparty("ext_B");
      await repo.createCounterpartyAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: cptyA.id,
        accountKind: "bank_account",
      });
      await repo.createCounterpartyAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: cptyB.id,
        accountKind: "crypto_wallet",
      });

      const { rows: rowsA, total: totalA } = await repo.listCounterpartyAccountsByCounterparty({
        counterpartyId: cptyA.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        limit: 50,
        offset: 0,
      });
      expect(totalA).toBe(1);
      expect(rowsA[0].counterparty_id).toBe(cptyA.id);
    });
  });

  describe("updateCounterpartyAccount", () => {
    it("patches label, details, and providerAccountData", async () => {
      const counterparty = await seedCounterparty();
      const account = await repo.createCounterpartyAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        accountKind: "crypto_wallet",
        label: "old",
        details: { network: "solana", address: "old" },
      });

      const updated = await repo.updateCounterpartyAccount({
        counterpartyAccountId: account?.id ?? "",
        counterpartyId: counterparty.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        label: "new",
        details: { network: "solana", address: "new" },
        providerAccountData: { provider: "grid", gridExternalAccountId: "ext_new" },
      });

      expect(updated?.label).toBe("new");
      expect(updated?.details).toMatchObject({ address: "new" });
      expect(updated?.provider_account_data).toMatchObject({ gridExternalAccountId: "ext_new" });
    });

    it("nulls label when explicitly set to null (sentinel pattern)", async () => {
      const counterparty = await seedCounterparty();
      const account = await repo.createCounterpartyAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        accountKind: "bank_account",
        label: "starts non-null",
      });

      const updated = await repo.updateCounterpartyAccount({
        counterpartyAccountId: account?.id ?? "",
        counterpartyId: counterparty.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        label: null,
      });
      expect(updated?.label).toBeNull();
    });

    it("leaves label untouched when omitted (sentinel guards against undefined-as-null)", async () => {
      const counterparty = await seedCounterparty();
      const account = await repo.createCounterpartyAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        accountKind: "bank_account",
        label: "keep me",
      });

      const updated = await repo.updateCounterpartyAccount({
        counterpartyAccountId: account?.id ?? "",
        counterpartyId: counterparty.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        details: { currency: "USD" },
      });
      expect(updated?.label).toBe("keep me");
    });

    it("returns null when target row is archived", async () => {
      const counterparty = await seedCounterparty();
      const account = await repo.createCounterpartyAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        accountKind: "bank_account",
      });
      await repo.archiveCounterpartyAccount({
        counterpartyAccountId: account?.id ?? "",
        counterpartyId: counterparty.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
      });

      const result = await repo.updateCounterpartyAccount({
        counterpartyAccountId: account?.id ?? "",
        counterpartyId: counterparty.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        label: "should not stick",
      });
      expect(result).toBeNull();
    });

    it("returns null when counterpartyId doesn't own the account (cross-counterparty defense)", async () => {
      const cptyA = await seedCounterparty("ext_A");
      const cptyB = await seedCounterparty("ext_B");
      const account = await repo.createCounterpartyAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: cptyA.id,
        accountKind: "bank_account",
        label: "owned by A",
      });

      const result = await repo.updateCounterpartyAccount({
        counterpartyAccountId: account?.id ?? "",
        counterpartyId: cptyB.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        label: "spoofed by B",
      });
      expect(result).toBeNull();

      const untouched = await repo.getCounterpartyAccountById({
        counterpartyAccountId: account?.id ?? "",
        counterpartyId: cptyA.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
      });
      expect(untouched?.label).toBe("owned by A");
    });
  });

  describe("archiveCounterpartyAccount", () => {
    it("marks an active row archived", async () => {
      const counterparty = await seedCounterparty();
      const account = await repo.createCounterpartyAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        accountKind: "bank_account",
      });

      const archived = await repo.archiveCounterpartyAccount({
        counterpartyAccountId: account?.id ?? "",
        counterpartyId: counterparty.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
      });
      expect(archived?.status).toBe("archived");
    });

    it("returns null when already archived", async () => {
      const counterparty = await seedCounterparty();
      const account = await repo.createCounterpartyAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        accountKind: "bank_account",
      });
      await repo.archiveCounterpartyAccount({
        counterpartyAccountId: account?.id ?? "",
        counterpartyId: counterparty.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
      });
      const second = await repo.archiveCounterpartyAccount({
        counterpartyAccountId: account?.id ?? "",
        counterpartyId: counterparty.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
      });
      expect(second).toBeNull();
    });

    it("returns null when counterpartyId doesn't own the account (cross-counterparty defense)", async () => {
      const cptyA = await seedCounterparty("ext_A");
      const cptyB = await seedCounterparty("ext_B");
      const account = await repo.createCounterpartyAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: cptyA.id,
        accountKind: "bank_account",
      });

      const spoofed = await repo.archiveCounterpartyAccount({
        counterpartyAccountId: account?.id ?? "",
        counterpartyId: cptyB.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
      });
      expect(spoofed).toBeNull();

      const stillActive = await repo.getCounterpartyAccountById({
        counterpartyAccountId: account?.id ?? "",
        counterpartyId: cptyA.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
      });
      expect(stillActive?.status).toBe("active");
    });
  });

  describe("listBatchRecipients", () => {
    async function seedNamed(displayName: string, externalId: string) {
      const counterpartiesRepo = createPostgresCounterpartiesRepository(getDb(env));
      const row = await counterpartiesRepo.createCounterparty({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        externalId,
        entityType: "individual",
        displayName,
        email: `${externalId}@example.com`,
        identity: { firstName: displayName },
        createdBy: TEST_USER.id,
      });
      if (!row) {
        throw new Error("failed to seed counterparty");
      }
      return row;
    }

    function seedSolanaAccount(counterpartyId: string, address: string, label: string | null) {
      return repo.createCounterpartyAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId,
        accountKind: "crypto_wallet",
        label,
        details: { network: "solana", address },
      });
    }

    it("returns only active Solana crypto-wallet accounts joined to their counterparty", async () => {
      const acme = await seedNamed("Acme Corp", "ext_acme");
      const beta = await seedNamed("Beta LLC", "ext_beta");

      await seedSolanaAccount(acme.id, "7xKqAcme", "Treasury");
      await seedSolanaAccount(beta.id, "3mPoBeta", null);
      // Excluded: bank account.
      await repo.createCounterpartyAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: acme.id,
        accountKind: "bank_account",
        details: { currency: "USD" },
      });
      // Excluded: non-Solana crypto wallet.
      await repo.createCounterpartyAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: beta.id,
        accountKind: "crypto_wallet",
        details: { network: "ethereum", address: "0xBeta" },
      });
      // Excluded: archived Solana wallet.
      const archived = await seedSolanaAccount(acme.id, "9zArchived", "old");
      await repo.archiveCounterpartyAccount({
        counterpartyAccountId: archived?.id ?? "",
        counterpartyId: acme.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
      });

      const { rows, total } = await repo.listBatchRecipients({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        limit: 50,
        offset: 0,
      });

      expect(total).toBe(2);
      // Ordered by display_name ASC.
      expect(rows[0]).toMatchObject({
        counterparty_display_name: "Acme Corp",
        address: "7xKqAcme",
        account_label: "Treasury",
      });
      expect(rows[1]).toMatchObject({
        counterparty_display_name: "Beta LLC",
        address: "3mPoBeta",
        account_label: null,
      });
    });

    it("filters by search on counterparty name (case-insensitive), not address", async () => {
      const acme = await seedNamed("Acme Corp", "ext_acme");
      const beta = await seedNamed("Beta LLC", "ext_beta");
      await seedSolanaAccount(acme.id, "7xKqAcme", null);
      await seedSolanaAccount(beta.id, "3mPoBeta", null);

      const byName = await repo.listBatchRecipients({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        search: "beta",
        limit: 50,
        offset: 0,
      });
      expect(byName.total).toBe(1);
      expect(byName.rows[0].counterparty_display_name).toBe("Beta LLC");

      // Address is not a search primitive — searching by an address matches nothing.
      const byAddress = await repo.listBatchRecipients({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        search: "7xKq",
        limit: 50,
        offset: 0,
      });
      expect(byAddress.total).toBe(0);
    });

    it("paginates with limit/offset while reporting the full total", async () => {
      const a = await seedNamed("Aaa", "ext_a");
      const b = await seedNamed("Bbb", "ext_b");
      const c = await seedNamed("Ccc", "ext_c");
      await seedSolanaAccount(a.id, "addrA", null);
      await seedSolanaAccount(b.id, "addrB", null);
      await seedSolanaAccount(c.id, "addrC", null);

      const page1 = await repo.listBatchRecipients({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        limit: 2,
        offset: 0,
      });
      expect(page1.total).toBe(3);
      expect(page1.rows).toHaveLength(2);
      expect(page1.rows[0].counterparty_display_name).toBe("Aaa");

      const page2 = await repo.listBatchRecipients({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        limit: 2,
        offset: 2,
      });
      expect(page2.total).toBe(3);
      expect(page2.rows).toHaveLength(1);
      expect(page2.rows[0].counterparty_display_name).toBe("Ccc");
    });

    it("restricts results to the given accountIds and combines with search", async () => {
      const acme = await seedNamed("Acme Corp", "ext_acme");
      const beta = await seedNamed("Beta LLC", "ext_beta");
      const acmeAccount = await seedSolanaAccount(acme.id, "7xKqAcme", null);
      const betaAccount = await seedSolanaAccount(beta.id, "3mPoBeta", null);
      if (!acmeAccount || !betaAccount) {
        throw new Error("failed to seed accounts");
      }

      const onlyAcme = await repo.listBatchRecipients({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        accountIds: [acmeAccount.id],
        limit: 50,
        offset: 0,
      });
      expect(onlyAcme.total).toBe(1);
      expect(onlyAcme.rows[0].account_id).toBe(acmeAccount.id);

      // Bind order must keep search and accountIds independent.
      const acmeFilteredBySearch = await repo.listBatchRecipients({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        accountIds: [acmeAccount.id, betaAccount.id],
        search: "beta",
        limit: 50,
        offset: 0,
      });
      expect(acmeFilteredBySearch.total).toBe(1);
      expect(acmeFilteredBySearch.rows[0].account_id).toBe(betaAccount.id);

      // An accountId outside the project resolves to nothing.
      const foreign = await repo.listBatchRecipients({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        accountIds: ["cpa_does_not_exist"],
        limit: 50,
        offset: 0,
      });
      expect(foreign.total).toBe(0);
    });
  });
});
