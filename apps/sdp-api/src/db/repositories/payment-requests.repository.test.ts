import { parseTokenAmount, toBaseUnits } from "@sdp/solana/token-amount";
import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { address, getBase58Decoder, signature } from "@solana/kit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import { env } from "@/test/helpers/env";
import {
  expectProjectScoped,
  type SeededDefaultProjects,
  seedDefaultProjects,
} from "@/test/helpers/projects";
import { nativeQuote } from "@/test/helpers/token-movement";
import { seedTestDatabase } from "@/test/mocks/db";
import type {
  CreatePaymentRequestInput,
  PaymentRequestsRepository,
} from "./payment-requests.repository";
import { createPostgresPaymentRequestsRepository } from "./payment-requests.repository.postgres";
import { recordedLegQuote } from "./token-movement-legs.repository";

const TEST_PROJECT_ID = "prj_preq_repo_test";
const DEVNET_USDC_MINT = address(WELL_KNOWN_TOKENS.USDC.mints.devnet.address);
/** The quote a claimed window's transaction moves: 1.5 SOL, a credit. */
const WINDOW_QUOTE = recordedLegQuote(nativeQuote("1.5", "credit"));
const signatureOf = (seed: number) =>
  signature(getBase58Decoder().decode(new Uint8Array(64).fill(seed)));
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
    overrides: Partial<CreatePaymentRequestInput> = {}
  ): CreatePaymentRequestInput {
    return {
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      custodyWalletId: TEST_CUSTODY_WALLET_ID,
      walletId: "wlt_receiving",
      destinationAddress: "OurWallet",
      token: DEVNET_USDC_MINT,
      amount: "25.00",
      expectation: {
        asset: { kind: "token", mint: DEVNET_USDC_MINT, program: "spl-token" },
        decimals: 6,
        credit: toBaseUnits(parseTokenAmount("25.00", 6)),
      },
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

    it("rejects a paid row with no settling transfer (paid_requires_transfer)", async () => {
      const created = await repo.createPaymentRequest(createInput());

      await expect(
        getDb(env)
          .prepare("UPDATE payment_requests SET status = 'paid' WHERE id = ?")
          .bind(created.id)
          .run()
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
        status: "expired",
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
          quote: WINDOW_QUOTE,
        }),
        repo.claimSponsoredTransactionWindow({
          requestId: request.id,
          account: ACCOUNT_B,
          unsignedTransaction: "dHhC",
          lastValidBlockHeight: 1_000n,
          currentBlockHeight: 900n,
          quote: WINDOW_QUOTE,
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
          quote: WINDOW_QUOTE,
        })
      ).toBe(true);
      expect(
        await repo.claimSponsoredTransactionWindow({
          requestId: request.id,
          account: ACCOUNT_B,
          unsignedTransaction: "dHhC",
          lastValidBlockHeight: 1_100n,
          currentBlockHeight: 950n,
          quote: WINDOW_QUOTE,
        })
      ).toBe(false);
      expect(
        await repo.claimSponsoredTransactionWindow({
          requestId: request.id,
          account: ACCOUNT_B,
          unsignedTransaction: "dHhC",
          lastValidBlockHeight: 1_200n,
          currentBlockHeight: 1_001n,
          quote: WINDOW_QUOTE,
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
        quote: WINDOW_QUOTE,
      });
      await repo.storeSponsoredTransactionSignature({
        requestId: request.id,
        account: ACCOUNT_B,
        unsignedTransaction: "dHhB",
        signedTransaction: "c2lnQg==",
        signature: signatureOf(11),
      });
      expect((await repo.getSponsoredTransactionClaim(request.id))?.signedTransaction).toBeNull();

      await repo.storeSponsoredTransactionSignature({
        requestId: request.id,
        account: ACCOUNT_A,
        unsignedTransaction: "dHhB",
        signedTransaction: "c2lnQQ==",
        signature: signatureOf(12),
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
        quote: WINDOW_QUOTE,
      });
      await repo.claimSponsoredTransactionWindow({
        requestId: request.id,
        account: ACCOUNT_A,
        unsignedTransaction: "dHhOZXc=",
        lastValidBlockHeight: 1_200n,
        currentBlockHeight: 1_001n,
        quote: WINDOW_QUOTE,
      });

      expect(
        await repo.storeSponsoredTransactionSignature({
          requestId: request.id,
          account: ACCOUNT_A,
          unsignedTransaction: "dHhPbGQ=",
          signedTransaction: "c2lnT2xk",
          signature: signatureOf(13),
        })
      ).toBe(false);
      expect((await repo.getSponsoredTransactionClaim(request.id))?.signedTransaction).toBeNull();

      expect(
        await repo.storeSponsoredTransactionSignature({
          requestId: request.id,
          account: ACCOUNT_A,
          unsignedTransaction: "dHhOZXc=",
          signedTransaction: "c2lnTmV3",
          signature: signatureOf(14),
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
      });
      expect(
        await repo.claimSponsoredTransactionWindow({
          requestId: request.id,
          account: ACCOUNT_A,
          unsignedTransaction: "dHhB",
          lastValidBlockHeight: 1_000n,
          currentBlockHeight: 900n,
          quote: WINDOW_QUOTE,
        })
      ).toBe(false);
    });

    describe("issued transactions and settlement (ADR 0012)", () => {
      const OWNER = { organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID };
      const PAYER = "9wVmMF2GpxZMsJLxCv2xXWjDWVv8HtqTmKqnZxNKkYTz";

      async function claimAndSign(requestId: string, unsigned: string, seed: number) {
        expect(
          await repo.claimSponsoredTransactionWindow({
            requestId,
            account: PAYER,
            unsignedTransaction: unsigned,
            lastValidBlockHeight: 1_000n + BigInt(seed),
            currentBlockHeight: 900n + BigInt(seed) * 1_000n,
            quote: WINDOW_QUOTE,
          })
        ).toBe(true);
        expect(
          await repo.storeSponsoredTransactionSignature({
            requestId,
            account: PAYER,
            unsignedTransaction: unsigned,
            signedTransaction: `signed-${unsigned}`,
            signature: signatureOf(seed),
          })
        ).toBe(true);
      }

      /**
       * Claims and signs one window per unsigned transaction, seeded 1, 2, …,
       * each once the one before it lapsed, then opens them all again. Two
       * signed windows are open at once only when a claim raced the signature
       * store of a window whose blockhash had already expired.
       */
      async function signOpenWindows(requestId: string, unsigned: readonly string[]) {
        for (const [index, transaction] of unsigned.entries()) {
          await claimAndSign(requestId, transaction, index + 1);
          await repo.closePaymentRequestTransactions({
            requestId,
            ...OWNER,
            outcomes: [{ signature: signatureOf(index + 1), outcome: "lapsed", landedSlot: null }],
          });
        }
        await getDb(env)
          .prepare(
            "UPDATE payment_request_transactions SET outcome = 'open' WHERE payment_request_id = ?"
          )
          .bind(requestId)
          .run();
      }

      it("stores the expectation with the request", async () => {
        const created = await repo.createPaymentRequest(createInput());

        expect(created.expectation).toEqual({
          asset: { kind: "token", mint: DEVNET_USDC_MINT, program: "spl-token" },
          decimals: 6,
          credit: 25_000_000n,
        });
      });

      it("refuses an expectation whose credit is not the amount (payment_requests_expectation_shape)", async () => {
        await expect(repo.createPaymentRequest(createInput({ amount: "26" }))).rejects.toThrow();
      });

      it("records each claim's issued transaction with its quote and saves its signature", async () => {
        const request = await repo.createPaymentRequest(createInput());
        await claimAndSign(request.id, "dHhB", 1);

        const claim = await repo.getSponsoredTransactionClaim(request.id);
        expect(claim?.issued).toMatchObject({
          payer: PAYER,
          lastValidBlockHeight: 1_001n,
          signature: signatureOf(1),
          quote: WINDOW_QUOTE,
          outcome: "open",
        });
        expect(
          await repo.listOpenPaymentRequestTransactions({ requestId: request.id, ...OWNER })
        ).toEqual([expect.objectContaining({ signature: signatureOf(1) })]);
      });

      it("refuses a new window while a signed one is still open, and admits one once it is closed", async () => {
        const request = await repo.createPaymentRequest(createInput());
        await claimAndSign(request.id, "dHhB", 1);
        const next = {
          requestId: request.id,
          account: PAYER,
          unsignedTransaction: "dHhC",
          lastValidBlockHeight: 3_000n,
          // Past the first window's last valid block height (1_001).
          currentBlockHeight: 2_000n,
          quote: WINDOW_QUOTE,
        };

        expect(await repo.claimSponsoredTransactionWindow(next)).toBe(false);

        await repo.closePaymentRequestTransactions({
          requestId: request.id,
          ...OWNER,
          outcomes: [{ signature: signatureOf(1), outcome: "lapsed", landedSlot: null }],
        });
        expect(await repo.claimSponsoredTransactionWindow(next)).toBe(true);
      });

      it("keeps every window's signature after a later claim replaces the request's claim", async () => {
        const request = await repo.createPaymentRequest(createInput());
        await claimAndSign(request.id, "dHhB", 1);
        await repo.closePaymentRequestTransactions({
          requestId: request.id,
          ...OWNER,
          outcomes: [{ signature: signatureOf(1), outcome: "lapsed", landedSlot: null }],
        });
        await claimAndSign(request.id, "dHhC", 2);

        const windows = await getDb(env)
          .prepare(
            `SELECT signature FROM payment_request_transactions
              WHERE payment_request_id = ? ORDER BY created_at, id`
          )
          .bind(request.id)
          .all<{ signature: string }>();
        expect(windows.results.map((issued) => issued.signature)).toEqual([
          signatureOf(1),
          signatureOf(2),
        ]);
        expect(
          (await repo.listOpenPaymentRequestTransactions({ requestId: request.id, ...OWNER })).map(
            (issued) => issued.signature
          )
        ).toEqual([signatureOf(2)]);
      });

      it("closes several windows in one statement and never reads or closes an archived one", async () => {
        const request = await repo.createPaymentRequest(createInput());
        await signOpenWindows(request.id, ["dHhB", "dHhC", "dHhD"]);
        await getDb(env)
          .prepare(
            "UPDATE payment_request_transactions SET status = 'archived' WHERE signature = ?"
          )
          .bind(signatureOf(3))
          .run();

        expect(
          (await repo.listOpenPaymentRequestTransactions({ requestId: request.id, ...OWNER })).map(
            (issued) => issued.signature
          )
        ).toEqual([signatureOf(1), signatureOf(2)]);

        await repo.closePaymentRequestTransactions({
          requestId: request.id,
          ...OWNER,
          outcomes: [
            { signature: signatureOf(1), outcome: "failed", landedSlot: 77n },
            { signature: signatureOf(2), outcome: "lapsed", landedSlot: null },
            { signature: signatureOf(3), outcome: "lapsed", landedSlot: null },
          ],
        });
        const outcomes = await getDb(env)
          .prepare(
            `SELECT signature, outcome, landed_slot FROM payment_request_transactions
              WHERE payment_request_id = ? ORDER BY created_at, id`
          )
          .bind(request.id)
          .all<{ signature: string; outcome: string; landed_slot: string | null }>();
        expect(outcomes.results).toEqual([
          { signature: signatureOf(1), outcome: "failed", landed_slot: "77" },
          { signature: signatureOf(2), outcome: "lapsed", landed_slot: null },
          { signature: signatureOf(3), outcome: "open", landed_slot: null },
        ]);
      });

      it("closes only the named request's windows, never another request's", async () => {
        const request = await repo.createPaymentRequest(createInput());
        const other = await repo.createPaymentRequest(createInput());
        await claimAndSign(request.id, "dHhB", 1);
        await claimAndSign(other.id, "dHhC", 2);

        await repo.closePaymentRequestTransactions({
          requestId: request.id,
          ...OWNER,
          outcomes: [
            { signature: signatureOf(1), outcome: "lapsed", landedSlot: null },
            { signature: signatureOf(2), outcome: "lapsed", landedSlot: null },
          ],
        });

        expect(
          await repo.listOpenPaymentRequestTransactions({ requestId: request.id, ...OWNER })
        ).toEqual([]);
        expect(
          (await repo.listOpenPaymentRequestTransactions({ requestId: other.id, ...OWNER })).map(
            (issued) => issued.signature
          )
        ).toEqual([signatureOf(2)]);
      });

      it("never signs a claim with no issued record (the previous revision's)", async () => {
        const request = await repo.createPaymentRequest(createInput());
        await getDb(env)
          .prepare(
            `UPDATE payment_requests
              SET sponsored_tx_account = ?, sponsored_tx_unsigned = 'bGVnYWN5',
                  sponsored_tx_last_valid_block_height = 1000
            WHERE id = ?`
          )
          .bind(PAYER, request.id)
          .run();

        expect((await repo.getSponsoredTransactionClaim(request.id))?.issued).toBeNull();
        await expect(
          repo.storeSponsoredTransactionSignature({
            requestId: request.id,
            account: PAYER,
            unsignedTransaction: "bGVnYWN5",
            signedTransaction: "c2lnbmVk",
            signature: signatureOf(3),
          })
        ).rejects.toThrow("no issued record");
        expect((await repo.getSponsoredTransactionClaim(request.id))?.signedTransaction).toBeNull();
      });

      it("refuses to claim a window for an expired request (SOLA9-761)", async () => {
        const request = await repo.createPaymentRequest(
          createInput({ expiresAt: new Date(Date.now() - 1_000).toISOString() })
        );

        expect(
          await repo.claimSponsoredTransactionWindow({
            requestId: request.id,
            account: PAYER,
            unsignedTransaction: "dHhB",
            lastValidBlockHeight: 1_000n,
            currentBlockHeight: 900n,
            quote: WINDOW_QUOTE,
          })
        ).toBe(false);
        expect(await repo.getSponsoredTransactionClaim(request.id)).toBeNull();
      });

      it("marks paid and links the settling transfer when the request was open at issue", async () => {
        const created = await repo.createPaymentRequest(createInput());
        await seedTransfer("xfr_settle");

        const paid = await repo.markPaymentRequestPaid({
          requestId: created.id,
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT_ID,
          fulfilledByTransferId: "xfr_settle",
          issuedAt: new Date().toISOString(),
        });

        expect(paid?.status).toBe("paid");
        expect(paid?.fulfilled_by_transfer_id).toBe("xfr_settle");
        expect(paid?.canceled_by).toBeNull();
        expect(paid?.lifecycle[1]).toMatchObject({ status: "paid" });
      });

      it("refuses to settle a request whose expiry came before the paying transaction was issued (SOLA9-757)", async () => {
        const expiresAt = new Date(Date.now() + 60_000).toISOString();
        const created = await repo.createPaymentRequest(createInput({ expiresAt }));
        await seedTransfer("xfr_late");

        expect(
          await repo.markPaymentRequestPaid({
            requestId: created.id,
            organizationId: TEST_ORG.id,
            projectId: TEST_PROJECT_ID,
            fulfilledByTransferId: "xfr_late",
            issuedAt: new Date(Date.now() + 120_000).toISOString(),
          })
        ).toBeNull();
        expect(
          (
            await repo.getPaymentRequestById({
              requestId: created.id,
              organizationId: TEST_ORG.id,
              projectId: TEST_PROJECT_ID,
            })
          )?.status
        ).toBe("awaiting_payment");
      });
    });
  });
});
