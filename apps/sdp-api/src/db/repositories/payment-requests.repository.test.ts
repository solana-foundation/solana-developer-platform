import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { createPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import { createTenantScope, TenantScopeViolationError } from "@/lib/tenant-scope";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import { env } from "@/test/helpers/env";
import {
  expectProjectScoped,
  type SeededDefaultProjects,
  seedDefaultProjects,
} from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import type { PaymentRequestsRepository } from "./payment-requests.repository";
import { createPostgresPaymentRequestsRepository } from "./payment-requests.repository.postgres";

const TEST_PROJECT_ID = "prj_preq_repo_test";
const TEST_CUSTODY_WALLET_ID = "cwlt_preq_repo_test";

describe("PaymentRequestsRepository (postgres)", () => {
  let repo: PaymentRequestsRepository;
  let projects: SeededDefaultProjects;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
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

    projects = await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [],
      ids: { sandbox: TEST_PROJECT_ID, production: `${TEST_PROJECT_ID}_production` },
    });
    await seedTestCustodyRows(env, {
      configs: [
        {
          id: "cfg_preq_repo_exact",
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT_ID,
          provider: "local",
          configEncrypted: "encrypted",
          status: "active",
        },
      ],
      wallets: [
        {
          id: TEST_CUSTODY_WALLET_ID,
          owner: { kind: "config", custodyConfigId: "cfg_preq_repo_exact" },
          walletId: "wlt_receiving",
          publicKey: "OurWallet",
          label: null,
          purpose: null,
          status: "active",
        },
      ],
    });

    repo = createPostgresPaymentRequestsRepository(db);
  });

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
      custodyWalletId: TEST_CUSTODY_WALLET_ID,
      walletId: "wlt_receiving",
      destinationAddress: "OurWallet",
      token: "USDC",
      amount: "25.00",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      createdBy: TEST_USER.id,
      ...overrides,
    };
  }

  describe("createPaymentRequest", () => {
    it("inserts and returns the row with a generated id and awaiting_payment status", async () => {
      const row = await repo.createPaymentRequest(createInput());

      expect(row).not.toBeNull();
      expect(row?.id).toMatch(/^preq_/);
      expect(row?.amount).toBe("25.00");
      expect(row?.custody_wallet_id).toBe(TEST_CUSTODY_WALLET_ID);
      expect(row?.status).toBe("awaiting_payment");
      expect(row?.fulfilled_by_transfer_id).toBeNull();
      expect(row?.canceled_by).toBeNull();
    });

    it("persists an explicitly selected exact wallet", async () => {
      const row = await repo.createPaymentRequest(
        createInput({ custodyWalletId: TEST_CUSTODY_WALLET_ID })
      );

      expect(row.custody_wallet_id).toBe(TEST_CUSTODY_WALLET_ID);
    });

    it("seeds the lifecycle log with the creation event", async () => {
      const row = await repo.createPaymentRequest(createInput());

      expect(row?.lifecycle).toHaveLength(1);
      expect(row?.lifecycle[0]).toMatchObject({ status: "awaiting_payment" });
      expect(row?.lifecycle[0].at).toEqual(expect.any(String));
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

  describe("listPaymentRequestsToReconcile", () => {
    async function seedCandidate(params: {
      projectId: string;
      expiresAt: string | null;
      reconciledAt: string | null;
    }) {
      const row = await repo.createPaymentRequest(
        createInput({ projectId: params.projectId, expiresAt: params.expiresAt })
      );
      await getDb(env)
        .prepare("UPDATE payment_requests SET reconciled_at = ? WHERE id = ?")
        .bind(params.reconciledAt, row.id)
        .run();
      return row;
    }

    it("selects the environment's open requests inside the expiry cutoff, least recently reconciled first", async () => {
      const newerReconciled = await seedCandidate({
        projectId: TEST_PROJECT_ID,
        expiresAt: null,
        reconciledAt: "2026-05-12T00:00:00.000Z",
      });
      const olderReconciled = await seedCandidate({
        projectId: TEST_PROJECT_ID,
        expiresAt: "2026-05-10T00:01:00.000Z",
        reconciledAt: "2026-05-11T00:00:00.000Z",
      });
      const neverReconciled = await seedCandidate({
        projectId: TEST_PROJECT_ID,
        expiresAt: null,
        reconciledAt: null,
      });
      await seedCandidate({
        projectId: `${TEST_PROJECT_ID}_production`,
        expiresAt: null,
        reconciledAt: null,
      });
      const paid = await seedCandidate({
        projectId: TEST_PROJECT_ID,
        expiresAt: null,
        reconciledAt: null,
      });
      await seedTransfer("xfr_reconcile_paid");
      await repo.markPaymentRequest({
        requestId: paid.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        status: "paid",
        fulfilledByTransferId: "xfr_reconcile_paid",
        canceledBy: null,
      });
      const unresolvedWallet = await seedCandidate({
        projectId: TEST_PROJECT_ID,
        expiresAt: null,
        reconciledAt: null,
      });
      await getDb(env)
        .prepare("UPDATE payment_requests SET custody_wallet_id = NULL WHERE id = ?")
        .bind(unresolvedWallet.id)
        .run();
      await seedCandidate({
        projectId: TEST_PROJECT_ID,
        expiresAt: "2026-05-09T00:00:00.000Z",
        reconciledAt: null,
      });

      const rows = await repo.listPaymentRequestsToReconcile({
        environment: "sandbox",
        expiredAfter: "2026-05-10T00:00:00.000Z",
        limit: 50,
      });

      expect(rows.map((row) => row.id)).toEqual([
        neverReconciled.id,
        olderReconciled.id,
        newerReconciled.id,
      ]);
    });

    it("is unavailable to a tenant-bound repository", () => {
      const tenantRepo = createPaymentRequestsRepository(
        env,
        createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID })
      );

      expect(() =>
        tenantRepo.listPaymentRequestsToReconcile({
          environment: "sandbox",
          expiredAfter: "2026-05-10T00:00:00.000Z",
          limit: 50,
        })
      ).toThrow(TenantScopeViolationError);
    });
  });

  describe("markPaymentRequestsReconciled", () => {
    it("stamps exactly the given requests and leaves their status and updated_at alone", async () => {
      const first = await repo.createPaymentRequest(createInput());
      const second = await repo.createPaymentRequest(createInput());
      const untouched = await repo.createPaymentRequest(createInput());
      await getDb(env)
        .prepare("UPDATE payment_requests SET updated_at = ?")
        .bind("2026-05-01T00:00:00.000Z")
        .run();

      await repo.markPaymentRequestsReconciled([first.id, second.id]);

      const rows = await getDb(env)
        .prepare("SELECT id, status, updated_at, reconciled_at FROM payment_requests")
        .all<{ id: string; status: string; updated_at: string; reconciled_at: string | null }>();
      expect(Object.fromEntries(rows.results.map((row) => [row.id, row]))).toEqual({
        [first.id]: {
          id: first.id,
          status: "awaiting_payment",
          updated_at: "2026-05-01T00:00:00.000Z",
          reconciled_at: expect.any(String),
        },
        [second.id]: {
          id: second.id,
          status: "awaiting_payment",
          updated_at: "2026-05-01T00:00:00.000Z",
          reconciled_at: expect.any(String),
        },
        [untouched.id]: {
          id: untouched.id,
          status: "awaiting_payment",
          updated_at: "2026-05-01T00:00:00.000Z",
          reconciled_at: null,
        },
      });
    });

    it("is unavailable to a tenant-bound repository", () => {
      const tenantRepo = createPaymentRequestsRepository(
        env,
        createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID })
      );

      expect(() => tenantRepo.markPaymentRequestsReconciled(["preq_tenant_mark"])).toThrow(
        TenantScopeViolationError
      );
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

    it("returns null when org doesn't match (tenancy guard)", async () => {
      const created = await repo.createPaymentRequest(createInput());

      const row = await repo.getPaymentRequestById({
        requestId: created?.id ?? "",
        organizationId: "org_does_not_exist",
        projectId: TEST_PROJECT_ID,
      });
      expect(row).toBeNull();
    });

    it("returns null when the project does not match", async () => {
      const created = await repo.createPaymentRequest(createInput());
      if (!created) throw new Error("createPaymentRequest returned null");
      await expectProjectScoped(
        (projectId) =>
          repo.getPaymentRequestById({
            requestId: created.id,
            organizationId: TEST_ORG.id,
            projectId,
          }),
        { own: projects.sandbox, other: projects.production },
        (row) => row === null
      );
    });
  });

  describe("listPaymentRequests", () => {
    it("returns rows newest first with a total", async () => {
      const first = await repo.createPaymentRequest(createInput());
      const second = await repo.createPaymentRequest(createInput());

      const db = getDb(env);
      await db
        .prepare("UPDATE payment_requests SET created_at = ? WHERE id = ?")
        .bind("2026-01-01T00:00:00.000Z", first?.id)
        .run();
      await db
        .prepare("UPDATE payment_requests SET created_at = ? WHERE id = ?")
        .bind("2026-01-01T00:00:01.000Z", second?.id)
        .run();

      const { rows, total } = await repo.listPaymentRequests({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        limit: 50,
        offset: 0,
      });

      expect(total).toBe(2);
      expect(rows.map((row) => row.id)).toEqual([second?.id, first?.id]);
    });

    it("scopes lists by project", async () => {
      await repo.createPaymentRequest(createInput());
      await expectProjectScoped(
        (projectId) =>
          repo.listPaymentRequests({
            organizationId: TEST_ORG.id,
            projectId,
            limit: 50,
            offset: 0,
          }),
        { own: projects.sandbox, other: projects.production },
        ({ rows }) => rows.length === 0
      );
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

    it("does not transition another project's request", async () => {
      const created = await repo.createPaymentRequest(createInput());
      if (!created) throw new Error("createPaymentRequest returned null");
      const transition = (projectId: string) =>
        repo.markPaymentRequest({
          requestId: created.id,
          organizationId: TEST_ORG.id,
          projectId,
          status: "canceled",
          fulfilledByTransferId: null,
          canceledBy: TEST_USER.id,
        });
      await expectProjectScoped(
        transition,
        { own: projects.sandbox, other: projects.production },
        (row) => row === null
      );
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
  });
});
