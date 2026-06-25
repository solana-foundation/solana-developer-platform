import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { createPostgresCounterpartiesRepository } from "./counterparty.repository.postgres";
import type { PaymentRequestsRepository } from "./payment-requests.repository";
import { createPostgresPaymentRequestsRepository } from "./payment-requests.repository.postgres";

const TEST_PROJECT_ID = "prj_preq_repo_test";
const OTHER_PROJECT_ID = "prj_preq_repo_test_other";

describe("PaymentRequestsRepository (postgres)", () => {
  let repo: PaymentRequestsRepository;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await clearTestDatabase(env as Parameters<typeof clearTestDatabase>[0]);
  });

  beforeEach(async () => {
    const db = getDb(env);
    await db.prepare("DELETE FROM payment_requests").run();
    await db.prepare("DELETE FROM payment_transfers").run();
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

    for (const projectId of [TEST_PROJECT_ID, OTHER_PROJECT_ID]) {
      await db
        .prepare(
          `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, 'Test Project', ?, 'sandbox', 'active', ?)`
        )
        .bind(projectId, TEST_ORG.id, projectId, TEST_USER.id)
        .run();
    }

    repo = createPostgresPaymentRequestsRepository(db);
  });

  async function seedCounterparty(externalId: string | null = null) {
    const counterpartiesRepo = createPostgresCounterpartiesRepository(getDb(env));
    const row = await counterpartiesRepo.createCounterparty({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      externalId,
      entityType: "individual",
      displayName: "Acme Payer",
      email: "acme@example.com",
      identity: { firstName: "Acme" },
      createdBy: TEST_USER.id,
    });
    if (!row) {
      throw new Error("failed to seed counterparty");
    }
    return row;
  }

  async function seedTransfer(id: string) {
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers (
           id, organization_id, project_id, wallet_id, source_address, destination_address,
           token, amount, type, direction, status, created_at, updated_at
         ) VALUES (?, ?, ?, 'wlt_x', 'PayerAddr', 'OurWallet', 'USDC', '10', 'transfer', 'inbound', 'processing',
                   '2026-06-23T00:00:00.000Z', '2026-06-23T00:00:00.000Z')`
      )
      .bind(id, TEST_ORG.id, TEST_PROJECT_ID)
      .run();
  }

  function createInput(
    overrides: Partial<Parameters<PaymentRequestsRepository["createPaymentRequest"]>[0]> = {}
  ) {
    return {
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: null,
      walletId: "wlt_receiving",
      destinationAddress: "OurWallet",
      token: "USDC",
      amount: "25.00",
      expiresAt: "2026-07-01T00:00:00.000Z",
      createdBy: TEST_USER.id,
      ...overrides,
    };
  }

  describe("createPaymentRequest", () => {
    it("inserts and returns the row with a generated id and awaiting_payment status", async () => {
      const counterparty = await seedCounterparty();

      const row = await repo.createPaymentRequest(createInput({ counterpartyId: counterparty.id }));

      expect(row).not.toBeNull();
      expect(row?.id).toMatch(/^preq_/);
      expect(row?.counterparty_id).toBe(counterparty.id);
      expect(row?.amount).toBe("25.00");
      expect(row?.status).toBe("awaiting_payment");
      expect(row?.fulfilled_by_transfer_id).toBeNull();
      expect(row?.canceled_by).toBeNull();
    });

    it("seeds the lifecycle log with the creation event", async () => {
      const row = await repo.createPaymentRequest(createInput());

      expect(row?.lifecycle).toHaveLength(1);
      expect(row?.lifecycle[0]).toMatchObject({ status: "awaiting_payment" });
      expect(row?.lifecycle[0].at).toEqual(expect.any(String));
    });

    it("supports an open link (null counterparty)", async () => {
      const row = await repo.createPaymentRequest(createInput({ counterpartyId: null }));
      expect(row?.counterparty_id).toBeNull();
    });

    it("generates a public_token distinct from the id", async () => {
      const first = await repo.createPaymentRequest(createInput());
      const second = await repo.createPaymentRequest(createInput());

      expect(first?.public_token).toMatch(/^[A-Za-z0-9_-]{16}$/);
      expect(first?.public_token).not.toBe(first?.id);
      expect(first?.public_token).not.toBe(second?.public_token);
    });
  });

  describe("getPaymentRequestByPublicToken", () => {
    it("resolves a row by its public token, unscoped by org/project", async () => {
      const created = await repo.createPaymentRequest(createInput());

      const row = await repo.getPaymentRequestByPublicToken(created?.public_token ?? "");
      expect(row?.id).toBe(created?.id);
    });

    it("returns null for an unknown token", async () => {
      const row = await repo.getPaymentRequestByPublicToken("does_not_exist0");
      expect(row).toBeNull();
    });
  });

  describe("getPaymentRequestById", () => {
    it("returns the row when org and project match", async () => {
      const created = await repo.createPaymentRequest(createInput());

      const row = await repo.getPaymentRequestById({
        requestId: created?.id ?? "",
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
      });
      expect(row?.id).toBe(created?.id);
    });

    it("returns null when project doesn't match (tenancy guard)", async () => {
      const created = await repo.createPaymentRequest(createInput());

      const row = await repo.getPaymentRequestById({
        requestId: created?.id ?? "",
        organizationId: TEST_ORG.id,
        projectId: OTHER_PROJECT_ID,
      });
      expect(row).toBeNull();
    });

    it("returns null when org doesn't match (tenancy guard)", async () => {
      const created = await repo.createPaymentRequest(createInput());

      const row = await repo.getPaymentRequestById({
        requestId: created?.id ?? "",
        organizationId: "org_does_not_exist",
        projectId: TEST_PROJECT_ID,
      });
      expect(row).toBeNull();
    });
  });

  describe("listPaymentRequests", () => {
    it("returns rows newest first with a total", async () => {
      const first = await repo.createPaymentRequest(createInput());
      const second = await repo.createPaymentRequest(createInput());

      const { rows, total } = await repo.listPaymentRequests({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        limit: 50,
        offset: 0,
      });

      expect(total).toBe(2);
      expect(rows.map((row) => row.id)).toEqual([second?.id, first?.id]);
    });

    it("filters by status", async () => {
      const toCancel = await repo.createPaymentRequest(createInput());
      await repo.createPaymentRequest(createInput());
      await repo.markPaymentRequest({
        requestId: toCancel?.id ?? "",
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        status: "canceled",
        fulfilledByTransferId: null,
        canceledBy: TEST_USER.id,
      });

      const { rows, total } = await repo.listPaymentRequests({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        status: "awaiting_payment",
        limit: 50,
        offset: 0,
      });

      expect(total).toBe(1);
      expect(rows[0].status).toBe("awaiting_payment");
    });

    it("scopes by project — requests in a sibling project are excluded", async () => {
      await repo.createPaymentRequest(createInput({ projectId: TEST_PROJECT_ID }));
      await repo.createPaymentRequest(createInput({ projectId: OTHER_PROJECT_ID }));

      const { rows, total } = await repo.listPaymentRequests({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        limit: 50,
        offset: 0,
      });
      expect(total).toBe(1);
      expect(rows[0].project_id).toBe(TEST_PROJECT_ID);
    });
  });

  describe("markPaymentRequest", () => {
    it("cancels an awaiting request and appends a lifecycle event", async () => {
      const created = await repo.createPaymentRequest(createInput());

      const canceled = await repo.markPaymentRequest({
        requestId: created?.id ?? "",
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        status: "canceled",
        fulfilledByTransferId: null,
        canceledBy: TEST_USER.id,
      });

      expect(canceled?.status).toBe("canceled");
      expect(canceled?.canceled_by).toBe(TEST_USER.id);
      expect(canceled?.lifecycle).toHaveLength(2);
      expect(canceled?.lifecycle[1]).toMatchObject({ status: "canceled" });
    });

    it("marks paid and links the settling transfer", async () => {
      const created = await repo.createPaymentRequest(createInput());
      await seedTransfer("xfr_settle");

      const paid = await repo.markPaymentRequest({
        requestId: created?.id ?? "",
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        status: "paid",
        fulfilledByTransferId: "xfr_settle",
        canceledBy: null,
      });

      expect(paid?.status).toBe("paid");
      expect(paid?.fulfilled_by_transfer_id).toBe("xfr_settle");
      expect(paid?.canceled_by).toBeNull();
      expect(paid?.lifecycle[1]).toMatchObject({ status: "paid" });
    });

    it("rejects a paid transition with no settling transfer (paid_requires_transfer)", async () => {
      const created = await repo.createPaymentRequest(createInput());

      await expect(
        repo.markPaymentRequest({
          requestId: created.id,
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT_ID,
          status: "paid",
          fulfilledByTransferId: null,
          canceledBy: null,
        })
      ).rejects.toThrow();
    });

    it("rejects canceled_by on a non-cancel transition (canceled_by_only_when_canceled)", async () => {
      const created = await repo.createPaymentRequest(createInput());

      await expect(
        repo.markPaymentRequest({
          requestId: created.id,
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT_ID,
          status: "expired",
          fulfilledByTransferId: null,
          canceledBy: TEST_USER.id,
        })
      ).rejects.toThrow();
    });

    it("expires an awaiting request", async () => {
      const created = await repo.createPaymentRequest(createInput());

      const expired = await repo.markPaymentRequest({
        requestId: created?.id ?? "",
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        status: "expired",
        fulfilledByTransferId: null,
        canceledBy: null,
      });
      expect(expired?.status).toBe("expired");
    });

    it("returns null and is a no-op when the request is already terminal", async () => {
      const created = await repo.createPaymentRequest(createInput());
      await repo.markPaymentRequest({
        requestId: created?.id ?? "",
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        status: "canceled",
        fulfilledByTransferId: null,
        canceledBy: TEST_USER.id,
      });

      const second = await repo.markPaymentRequest({
        requestId: created?.id ?? "",
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        status: "paid",
        fulfilledByTransferId: null,
        canceledBy: null,
      });
      expect(second).toBeNull();

      const current = await repo.getPaymentRequestById({
        requestId: created?.id ?? "",
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
      });
      expect(current?.status).toBe("canceled");
    });

    it("returns null when project doesn't match (tenancy guard)", async () => {
      const created = await repo.createPaymentRequest(createInput());

      const result = await repo.markPaymentRequest({
        requestId: created?.id ?? "",
        organizationId: TEST_ORG.id,
        projectId: OTHER_PROJECT_ID,
        status: "canceled",
        fulfilledByTransferId: null,
        canceledBy: TEST_USER.id,
      });
      expect(result).toBeNull();
    });
  });
});
