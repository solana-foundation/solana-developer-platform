import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import {
  createPaymentRequestsRepository,
  createSystemPaymentRequestsRepository,
} from "@/db/repositories/repository-factory";
import { createTenantScope } from "@/lib/tenant-scope";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import { env } from "@/test/helpers/env";
import {
  expectProjectScoped,
  type SeededDefaultProjects,
  seedDefaultProjects,
} from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import type { PaymentRequestRow, PaymentRequestsRepository } from "./payment-requests.repository";
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

  async function seedInboundTransfer(request: PaymentRequestRow): Promise<string> {
    const transferId = `xfr_${request.id}`;
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers (
           id, organization_id, project_id, custody_wallet_id, wallet_id, source_address,
           destination_address, token, amount, type, direction, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'PayerAddr', ?, ?, ?, 'transfer', 'inbound', 'confirmed',
                   '2026-06-23T00:00:00.000Z', '2026-06-23T00:00:00.000Z')`
      )
      .bind(
        transferId,
        TEST_ORG.id,
        TEST_PROJECT_ID,
        TEST_CUSTODY_WALLET_ID,
        request.wallet_id,
        request.destination_address,
        request.token,
        request.amount
      )
      .run();
    return transferId;
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
        paidLate: false,
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
        paidLate: false,
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
          paidLate: false,
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
        paidLate: false,
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
          paidLate: false,
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
          paidLate: false,
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
        paidLate: false,
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
        paidLate: false,
      });

      const second = await repo.markPaymentRequest({
        requestId: created?.id ?? "",
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        status: "paid",
        fulfilledByTransferId: null,
        canceledBy: null,
        paidLate: false,
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

  describe("sponsored transaction window", () => {
    const ACCOUNT_A = "9wVmMF2GpxZMsJLxCv2xXWjDWVv8HtqTmKqnZxNKkYTz";
    const ACCOUNT_B = "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJfhRhPkV";

    it("admits exactly one of two concurrent claims", async () => {
      const request = await repo.createPaymentRequest(createInput());
      const results = await Promise.all([
        repo.claimSponsoredTransactionWindow({
          requestId: request.id,
          account: ACCOUNT_A,
          unsignedTransaction: "dHhB",
          lastValidBlockHeight: 1_000n,
          currentBlockHeight: 900n,
        }),
        repo.claimSponsoredTransactionWindow({
          requestId: request.id,
          account: ACCOUNT_B,
          unsignedTransaction: "dHhC",
          lastValidBlockHeight: 1_000n,
          currentBlockHeight: 900n,
        }),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);

      const claim = await repo.getSponsoredTransactionClaim(request.id);
      expect(claim).not.toBeNull();
      expect([ACCOUNT_A, ACCOUNT_B]).toContain(claim?.account);
      expect(claim?.signedTransaction).toBeNull();
      expect(claim?.lastValidBlockHeight).toBe(1_000n);
    });

    it("refuses a reclaim while the window is live and admits one after expiry", async () => {
      const request = await repo.createPaymentRequest(createInput());
      expect(
        await repo.claimSponsoredTransactionWindow({
          requestId: request.id,
          account: ACCOUNT_A,
          unsignedTransaction: "dHhB",
          lastValidBlockHeight: 1_000n,
          currentBlockHeight: 900n,
        })
      ).toBe(true);
      expect(
        await repo.claimSponsoredTransactionWindow({
          requestId: request.id,
          account: ACCOUNT_B,
          unsignedTransaction: "dHhC",
          lastValidBlockHeight: 1_100n,
          currentBlockHeight: 950n,
        })
      ).toBe(false);
      expect(
        await repo.claimSponsoredTransactionWindow({
          requestId: request.id,
          account: ACCOUNT_B,
          unsignedTransaction: "dHhC",
          lastValidBlockHeight: 1_200n,
          currentBlockHeight: 1_001n,
        })
      ).toBe(true);
      const claim = await repo.getSponsoredTransactionClaim(request.id);
      expect(claim?.account).toBe(ACCOUNT_B);
      expect(claim?.signedTransaction).toBeNull();
    });

    it("stores the signature for the claiming account only", async () => {
      const request = await repo.createPaymentRequest(createInput());
      await repo.claimSponsoredTransactionWindow({
        requestId: request.id,
        account: ACCOUNT_A,
        unsignedTransaction: "dHhB",
        lastValidBlockHeight: 1_000n,
        currentBlockHeight: 900n,
      });
      await repo.storeSponsoredTransactionSignature({
        requestId: request.id,
        account: ACCOUNT_B,
        unsignedTransaction: "dHhB",
        signedTransaction: "c2lnQg==",
      });
      expect((await repo.getSponsoredTransactionClaim(request.id))?.signedTransaction).toBeNull();

      await repo.storeSponsoredTransactionSignature({
        requestId: request.id,
        account: ACCOUNT_A,
        unsignedTransaction: "dHhB",
        signedTransaction: "c2lnQQ==",
      });
      expect((await repo.getSponsoredTransactionClaim(request.id))?.signedTransaction).toBe(
        "c2lnQQ=="
      );
    });

    it("refuses a stale signature written against superseded unsigned bytes", async () => {
      const request = await repo.createPaymentRequest(createInput());
      await repo.claimSponsoredTransactionWindow({
        requestId: request.id,
        account: ACCOUNT_A,
        unsignedTransaction: "dHhPbGQ=",
        lastValidBlockHeight: 1_000n,
        currentBlockHeight: 900n,
      });
      await repo.claimSponsoredTransactionWindow({
        requestId: request.id,
        account: ACCOUNT_A,
        unsignedTransaction: "dHhOZXc=",
        lastValidBlockHeight: 1_200n,
        currentBlockHeight: 1_001n,
      });

      expect(
        await repo.storeSponsoredTransactionSignature({
          requestId: request.id,
          account: ACCOUNT_A,
          unsignedTransaction: "dHhPbGQ=",
          signedTransaction: "c2lnT2xk",
        })
      ).toBe(false);
      expect((await repo.getSponsoredTransactionClaim(request.id))?.signedTransaction).toBeNull();

      expect(
        await repo.storeSponsoredTransactionSignature({
          requestId: request.id,
          account: ACCOUNT_A,
          unsignedTransaction: "dHhOZXc=",
          signedTransaction: "c2lnTmV3",
        })
      ).toBe(true);
      expect((await repo.getSponsoredTransactionClaim(request.id))?.signedTransaction).toBe(
        "c2lnTmV3"
      );
    });

    it("refuses a claim on a request that is not awaiting payment", async () => {
      const request = await repo.createPaymentRequest(createInput());
      await repo.markPaymentRequest({
        requestId: request.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        status: "canceled",
        fulfilledByTransferId: null,
        canceledBy: TEST_USER.id,
        paidLate: false,
      });
      expect(
        await repo.claimSponsoredTransactionWindow({
          requestId: request.id,
          account: ACCOUNT_A,
          unsignedTransaction: "dHhB",
          lastValidBlockHeight: 1_000n,
          currentBlockHeight: 900n,
        })
      ).toBe(false);
    });
  });

  describe("reconciler constraint", () => {
    it("refuses paid_late on a request that is not paid", async () => {
      const request = await repo.createPaymentRequest(createInput({ token: SOL_MINT }));
      await expect(
        getDb(env)
          .prepare("UPDATE payment_requests SET paid_late = true WHERE id = ?")
          .bind(request.id)
          .run()
      ).rejects.toThrow(/payment_requests_paid_late_only_when_paid/);
    });
  });

  describe("reconciler queries", () => {
    it("lists hot requests whose sponsored transaction can still land, stalest first", async () => {
      const live = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: null })
      );
      const lapsedClaim = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: null })
      );
      const noClaim = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: null })
      );
      const db = getDb(env);
      await db
        .prepare(
          `UPDATE payment_requests SET sponsored_tx_account = 'acct', sponsored_tx_unsigned = 'tx',
             sponsored_tx_last_valid_block_height = ? WHERE id = ?`
        )
        .bind("1000", live.id)
        .run();
      await db
        .prepare(
          `UPDATE payment_requests SET sponsored_tx_account = 'acct', sponsored_tx_unsigned = 'tx',
             sponsored_tx_last_valid_block_height = ? WHERE id = ?`
        )
        .bind("10", lapsedClaim.id)
        .run();

      const rows = await createSystemPaymentRequestsRepository(env).listHotPaymentRequests({
        environment: "sandbox",
        minLastValidBlockHeight: 500n,
        limit: 10,
      });

      expect(rows.map((row) => row.id)).toEqual([live.id]);
      expect(rows.map((row) => row.id)).not.toContain(noClaim.id);
    });

    it("lists unexpired awaiting requests not checked since the cutoff, never-checked first", async () => {
      const never = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: null })
      );
      const old = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: null })
      );
      const fresh = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: null })
      );
      const lapsed = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: "2020-01-01T00:00:00.000Z" })
      );
      const db = getDb(env);
      await db
        .prepare("UPDATE payment_requests SET last_checked_at = ? WHERE id = ?")
        .bind("2026-01-01T00:00:00.000Z", old.id)
        .run();
      await db
        .prepare("UPDATE payment_requests SET last_checked_at = ? WHERE id = ?")
        .bind("2099-01-01T00:00:00.000Z", fresh.id)
        .run();

      const rows = await createSystemPaymentRequestsRepository(env).listPaymentRequestsDueForCheck({
        environment: "sandbox",
        checkedBefore: "2026-06-01T00:00:00.000Z",
        limit: 10,
      });

      expect(rows.map((row) => row.id)).toEqual([never.id, old.id]);
      expect(rows.map((row) => row.id)).not.toContain(lapsed.id);
    });

    it("does not list another environment's requests", async () => {
      await repo.createPaymentRequest(createInput({ token: SOL_MINT, expiresAt: null }));
      const rows = await createSystemPaymentRequestsRepository(env).listPaymentRequestsDueForCheck({
        environment: "production",
        checkedBefore: "2099-01-01T00:00:00.000Z",
        limit: 10,
      });
      expect(rows).toEqual([]);
    });

    it("lists awaiting requests past expires_at as lapsed", async () => {
      const lapsed = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: "2020-01-01T00:00:00.000Z" })
      );
      await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: "2099-01-01T00:00:00.000Z" })
      );
      await repo.createPaymentRequest(createInput({ token: SOL_MINT, expiresAt: null }));

      const rows = await createSystemPaymentRequestsRepository(env).listLapsedPaymentRequests({
        environment: "sandbox",
        limit: 10,
      });

      expect(rows.map((row) => row.id)).toEqual([lapsed.id]);
    });

    it("moves only an expired request to paid, recording lateness as given", async () => {
      const request = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: "2020-01-01T00:00:00.000Z" })
      );
      const transferId = await seedInboundTransfer(request);
      const systemRepo = createSystemPaymentRequestsRepository(env);
      const scoped = {
        requestId: request.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
      };

      expect(
        await systemRepo.markExpiredPaymentRequestPaid({
          ...scoped,
          fulfilledByTransferId: transferId,
          paidLate: true,
        })
      ).toBeNull();

      await repo.markPaymentRequest({
        ...scoped,
        status: "expired",
        fulfilledByTransferId: null,
        canceledBy: null,
        paidLate: false,
      });
      const paid = await systemRepo.markExpiredPaymentRequestPaid({
        ...scoped,
        fulfilledByTransferId: transferId,
        paidLate: true,
      });

      expect(paid).toMatchObject({
        status: "paid",
        paid_late: true,
        fulfilled_by_transfer_id: transferId,
      });
      expect(paid?.lifecycle.map((event) => event.status)).toEqual([
        "awaiting_payment",
        "expired",
        "paid",
      ]);
    });

    it("moves an expired request to paid on time when lateness is false", async () => {
      const request = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: "2020-01-01T00:00:00.000Z" })
      );
      const transferId = await seedInboundTransfer(request);
      const scoped = {
        requestId: request.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
      };
      await repo.markPaymentRequest({
        ...scoped,
        status: "expired",
        fulfilledByTransferId: null,
        canceledBy: null,
        paidLate: false,
      });

      const paid = await createSystemPaymentRequestsRepository(env).markExpiredPaymentRequestPaid({
        ...scoped,
        fulfilledByTransferId: transferId,
        paidLate: false,
      });

      expect(paid).toMatchObject({ status: "paid", paid_late: false });
    });

    it("stamps last_checked_at on every listed id", async () => {
      const a = await repo.createPaymentRequest(createInput({ token: SOL_MINT, expiresAt: null }));
      const b = await repo.createPaymentRequest(createInput({ token: SOL_MINT, expiresAt: null }));
      const systemRepo = createSystemPaymentRequestsRepository(env);

      await systemRepo.markPaymentRequestsChecked([a.id, b.id]);

      const rows = await Promise.all(
        [a, b].map((row) =>
          repo.getPaymentRequestById({
            requestId: row.id,
            organizationId: TEST_ORG.id,
            projectId: TEST_PROJECT_ID,
          })
        )
      );
      expect(rows.every((row) => row?.last_checked_at !== null)).toBe(true);
    });

    it("denies the reconciler methods to tenant callers", () => {
      const tenant = createPaymentRequestsRepository(
        env,
        createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID })
      );
      expect(() => tenant.markPaymentRequestsChecked([])).toThrow(/system-only/);
    });
  });
});
