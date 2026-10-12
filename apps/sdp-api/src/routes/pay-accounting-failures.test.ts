import type { FeePaymentPort, SponsorshipProviderConfiguration } from "@sdp/payments/fee-payment";
import { SOL_MINT } from "@sdp/types";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64Decoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createSystemPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import app from "@/index";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { adminDatabaseUrl, env } from "@/test/helpers/env";
import {
  createFeePaymentAdapterMock,
  createRpcMock,
  getRecentBlockhashMock,
  installPaymentsRouteTestHooks,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PROJECT,
  TEST_SPONSORSHIP_PROVIDER_CONFIG,
  TEST_USER,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";
import { sponsorSignTestTransaction, TEST_MOCK_FEE_PAYER } from "@/test/helpers/sponsor-signing";

describe("Public payment Request accounting failure recovery", () => {
  installPaymentsRouteTestHooks();

  const admin = new pg.Client({ connectionString: adminDatabaseUrl });
  let failingTable: "payment_requests" | "audit_logs" | null = null;
  let renamedAccountingTable = false;
  const provider = {
    providerId: "mock",
    getFeePayer: vi.fn(async () => TEST_MOCK_FEE_PAYER),
    getSponsorshipConfiguration: vi.fn(
      async (): Promise<SponsorshipProviderConfiguration> => TEST_SPONSORSHIP_PROVIDER_CONFIG
    ),
    signAsFeePayer: vi.fn(sponsorSignTestTransaction),
    signAndSend: vi.fn(async () => {
      throw new Error("Public pay does not send transactions");
    }),
  } satisfies FeePaymentPort;

  beforeAll(async () => {
    await admin.connect();
  });

  afterAll(async () => {
    await admin.end();
  });

  async function clearWriteFailure() {
    if (failingTable === null) return;
    await admin.query(`DROP TRIGGER pr3_request_write_failure ON ${failingTable}`);
    await admin.query("DROP FUNCTION pr3_request_write_failure()");
    failingTable = null;
  }

  afterEach(async () => {
    await clearWriteFailure();
    if (renamedAccountingTable) {
      await admin.query(
        "ALTER TABLE pr3_unavailable_reservations RENAME TO sponsorship_budget_reservations"
      );
      renamedAccountingTable = false;
    }
  });

  beforeEach(() => {
    createRpcMock.mockReturnValue({
      getSignaturesForAddress: () => ({ send: async () => [] }),
      getBlockHeight: () => ({ send: async () => 900n }),
      getFeeForMessage: () => ({ send: async () => ({ value: 5000n }) }),
    } as unknown as ReturnType<typeof import("@sdp/rpc/solana").createRpc>);
    provider.getSponsorshipConfiguration.mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG);
    provider.signAsFeePayer.mockImplementation(sponsorSignTestTransaction);
    createFeePaymentAdapterMock.mockReturnValue(provider);
  });

  async function failWrite(
    table: "payment_requests" | "audit_logs",
    event: "INSERT" | "UPDATE",
    condition: string
  ) {
    await admin.query(`CREATE FUNCTION pr3_request_write_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF ${condition} THEN RAISE EXCEPTION 'injected Request persistence failure'; END IF;
        RETURN NEW;
      END $$`);
    await admin.query(`CREATE TRIGGER pr3_request_write_failure BEFORE ${event} ON ${table}
      FOR EACH ROW EXECUTE FUNCTION pr3_request_write_failure()`);
    failingTable = table;
  }

  const repository = () => createSystemPaymentRequestsRepository(env);
  const createRequest = () =>
    repository().createPaymentRequest({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      counterpartyId: null,
      custodyWalletId: TEST_CUSTODY_WALLET_ID,
      walletId: TEST_WALLET_ID,
      destinationAddress: TEST_SOLANA_ADDRESSES.wallet1,
      token: SOL_MINT,
      amount: "1.5",
      expiresAt: null,
      createdBy: TEST_USER.id,
    });
  const post = async (token: string) =>
    app.request(
      `/pay/${token}/tx`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: TEST_SOLANA_ADDRESSES.wallet2 }),
      },
      env
    );
  const reservations = () =>
    getDb(env).queryMany<{
      id: string;
      status: string;
      attempt: number;
      signed_transaction: string | null;
    }>(
      `SELECT id, status, attempt, signed_transaction FROM sponsorship_budget_reservations
     WHERE organization_id = ? AND project_id = ? ORDER BY id`,
      [TEST_ORG.id, TEST_PROJECT.id]
    );

  function expireWindow() {
    createRpcMock.mockReturnValue({
      getSignaturesForAddress: () => ({ send: async () => [] }),
      getBlockHeight: () => ({ send: async () => 2000n }),
      getFeeForMessage: () => ({ send: async () => ({ value: 5000n }) }),
    } as unknown as ReturnType<typeof import("@sdp/rpc/solana").createRpc>);
    getRecentBlockhashMock.mockResolvedValue({
      blockhash: blockhash("1".repeat(32)),
      lastValidBlockHeight: 3000n,
    });
  }

  it("releases definitely unsigned admission when the claim accounting write fails, then retries the same reservation", async () => {
    const request = await createRequest();
    await failWrite(
      "payment_requests",
      "UPDATE",
      `NEW.sponsored_tx_continuity #> '{accountingIdentity}' <> 'null'::jsonb
      AND NEW.sponsored_tx_continuity IS DISTINCT FROM OLD.sponsored_tx_continuity`
    );

    expect((await post(request.public_token)).status).toBe(500);
    expect(provider.signAsFeePayer).not.toHaveBeenCalled();
    const released = await reservations();
    expect(released).toEqual([
      { id: expect.any(String), status: "released", attempt: 1, signed_transaction: null },
    ]);
    const claim = await repository().getSponsoredTransactionClaim(request.id);
    expect(claim).toMatchObject({ signedTransaction: null, accountingIdentity: null });

    await clearWriteFailure();
    const retry = await post(request.public_token);
    expect(retry.status).toBe(200);
    const bytes = ((await retry.json()) as { transaction: string }).transaction;
    expect(await reservations()).toEqual([
      { id: released[0].id, status: "signed", attempt: 2, signed_transaction: bytes },
    ]);
    expect(await repository().getSponsoredTransactionClaim(request.id)).toMatchObject({
      account: claim?.account,
      unsignedTransaction: claim?.unsignedTransaction,
      accountingIdentity: { reservationId: released[0].id, attempt: 2 },
      signedTransaction: bytes,
    });
    expect(provider.signAsFeePayer).toHaveBeenCalledOnce();
  });

  it("keeps a failed pre-effect attempt payable after its released window expires", async () => {
    const request = await createRequest();
    await failWrite(
      "payment_requests",
      "UPDATE",
      `NEW.sponsored_tx_continuity #> '{accountingIdentity}' <> 'null'::jsonb
      AND NEW.sponsored_tx_continuity IS DISTINCT FROM OLD.sponsored_tx_continuity`
    );
    expect((await post(request.public_token)).status).toBe(500);
    const released = await reservations();
    expect(released).toEqual([
      { id: expect.any(String), status: "released", attempt: 1, signed_transaction: null },
    ]);
    expect(provider.signAsFeePayer).not.toHaveBeenCalled();
    await clearWriteFailure();
    expireWindow();

    const retry = await post(request.public_token);
    expect(retry.status).toBe(200);
    const bytes = ((await retry.json()) as { transaction: string }).transaction;
    const updated = await reservations();
    expect(updated).toHaveLength(2);
    expect(updated).toContainEqual(released[0]);
    expect(updated).toContainEqual({
      id: expect.any(String),
      status: "signed",
      attempt: 1,
      signed_transaction: bytes,
    });
    expect(provider.signAsFeePayer).toHaveBeenCalledOnce();
  });

  it.each([
    {
      checkpoint: "audit",
      table: "audit_logs" as const,
      event: "INSERT" as const,
      condition: "NEW.resource_type = 'payment_request' AND NEW.action = 'sign'",
    },
    {
      checkpoint: "claim signature",
      table: "payment_requests" as const,
      event: "UPDATE" as const,
      condition:
        "NEW.sponsored_tx_signed IS NOT NULL AND NEW.sponsored_tx_signed IS DISTINCT FROM OLD.sponsored_tx_signed",
    },
  ])(
    "retains signed accounting bytes when the $checkpoint checkpoint fails and replays without signing again",
    async ({ table, event, condition }) => {
      const request = await createRequest();
      await failWrite(table, event, condition);

      expect((await post(request.public_token)).status).toBe(500);
      const original = await reservations();
      expect(original).toEqual([
        {
          id: expect.any(String),
          status: "signed",
          attempt: 1,
          signed_transaction: expect.any(String),
        },
      ]);
      const unsignedClaim = await repository().getSponsoredTransactionClaim(request.id);
      expect(unsignedClaim).toMatchObject({
        signedTransaction: null,
        accountingIdentity: { reservationId: original[0].id, attempt: 1 },
      });
      expect(provider.signAsFeePayer).toHaveBeenCalledOnce();

      await clearWriteFailure();
      const retry = await post(request.public_token);
      expect(retry.status).toBe(200);
      expect(((await retry.json()) as { transaction: string }).transaction).toBe(
        original[0].signed_transaction
      );
      expect(await reservations()).toEqual(original);
      expect(await repository().getSponsoredTransactionClaim(request.id)).toMatchObject({
        account: unsignedClaim?.account,
        unsignedTransaction: unsignedClaim?.unsignedTransaction,
        signedTransaction: original[0].signed_transaction,
        accountingIdentity: unsignedClaim?.accountingIdentity,
      });
      expect(provider.signAsFeePayer).toHaveBeenCalledOnce();
    }
  );

  it.each(["audit", "claim signature"] as const)(
    "recovers a known signed outcome after the %s checkpoint failed and the window expired",
    async (checkpoint) => {
      const request = await createRequest();
      await failWrite(
        checkpoint === "audit" ? "audit_logs" : "payment_requests",
        checkpoint === "audit" ? "INSERT" : "UPDATE",
        checkpoint === "audit"
          ? "NEW.resource_type = 'payment_request' AND NEW.action = 'sign'"
          : "NEW.sponsored_tx_signed IS NOT NULL AND NEW.sponsored_tx_signed IS DISTINCT FROM OLD.sponsored_tx_signed"
      );
      expect((await post(request.public_token)).status).toBe(500);
      const original = await reservations();
      expect(original).toEqual([
        {
          id: expect.any(String),
          status: "signed",
          attempt: 1,
          signed_transaction: expect.any(String),
        },
      ]);
      expect(await repository().getSponsoredTransactionClaim(request.id)).toMatchObject({
        signedTransaction: null,
        accountingIdentity: { reservationId: original[0].id },
      });
      await clearWriteFailure();
      expireWindow();

      const retry = await post(request.public_token);
      expect(retry.status).toBe(200);
      const bytes = ((await retry.json()) as { transaction: string }).transaction;
      expect(bytes).not.toBe(original[0].signed_transaction);
      const updated = await reservations();
      expect(updated).toHaveLength(2);
      expect(updated).toContainEqual(original[0]);
      expect(updated).toContainEqual({
        id: expect.any(String),
        status: "signed",
        attempt: 1,
        signed_transaction: bytes,
      });
      expect(await repository().getSponsoredTransactionClaim(request.id)).toMatchObject({
        signedTransaction: bytes,
        lastValidBlockHeight: 3000n,
      });
      expect(provider.signAsFeePayer).toHaveBeenCalledTimes(2);
    }
  );

  it("refuses a failed accounting SQL lookup without treating it as reservation absence", async () => {
    const request = await createRequest();
    expect((await post(request.public_token)).status).toBe(200);
    const original = await reservations();
    await getDb(env).execute(
      "UPDATE payment_requests SET sponsored_tx_signed = NULL WHERE id = ?",
      [request.id]
    );
    const unsignedClaim = await repository().getSponsoredTransactionClaim(request.id);

    // The isolated worker's rows remain intact while the real SELECT becomes unavailable.
    await admin.query(
      "ALTER TABLE sponsorship_budget_reservations RENAME TO pr3_unavailable_reservations"
    );
    renamedAccountingTable = true;
    expect((await post(request.public_token)).status).toBe(503);
    expect(provider.signAsFeePayer).toHaveBeenCalledOnce();
    expect(await repository().getSponsoredTransactionClaim(request.id)).toEqual(unsignedClaim);

    await admin.query(
      "ALTER TABLE pr3_unavailable_reservations RENAME TO sponsorship_budget_reservations"
    );
    renamedAccountingTable = false;
    expect(await reservations()).toEqual(original);
  });

  it.each(["fee payer", "security configuration"] as const)(
    "refuses %s drift on an unsigned claim without another provider effect",
    async (setting) => {
      const request = await createRequest();
      expect((await post(request.public_token)).status).toBe(200);
      const original = await reservations();
      await getDb(env).execute(
        "UPDATE payment_requests SET sponsored_tx_signed = NULL WHERE id = ?",
        [request.id]
      );
      const unsignedClaim = await repository().getSponsoredTransactionClaim(request.id);
      provider.getSponsorshipConfiguration.mockResolvedValue({
        ...TEST_SPONSORSHIP_PROVIDER_CONFIG,
        ...(setting === "fee payer"
          ? { signerAddress: address(TEST_SOLANA_ADDRESSES.wallet3) }
          : { maxAllowedLamports: 1n, feePayerMayTransferLamports: true }),
      });

      expect((await post(request.public_token)).status).toBe(503);
      expect(provider.signAsFeePayer).toHaveBeenCalledOnce();
      expect(await reservations()).toEqual(original);
      expect(await repository().getSponsoredTransactionClaim(request.id)).toEqual(unsignedClaim);
    }
  );

  it("fences a concurrent compatible payer retry while one provider owns the reserved message", async () => {
    const request = await createRequest();
    let releaseSigning = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseSigning = resolve;
    });
    let signingStarted = () => {};
    const started = new Promise<void>((resolve) => {
      signingStarted = resolve;
    });
    provider.signAsFeePayer.mockImplementationOnce(async (transaction) => {
      signingStarted();
      await gate;
      return sponsorSignTestTransaction(transaction);
    });
    const owner = post(request.public_token);
    let ownerResponse: Response | undefined;
    let ownedReservationId: string | undefined;
    try {
      await Promise.race([
        started,
        owner.then(() => {
          throw new Error("Request completed before signing");
        }),
      ]);
      const inProgress = await reservations();
      expect(inProgress).toEqual([
        { id: expect.any(String), status: "reserved", attempt: 1, signed_transaction: null },
      ]);
      ownedReservationId = inProgress[0].id;
      expect(await repository().getSponsoredTransactionClaim(request.id)).toMatchObject({
        accountingIdentity: { reservationId: ownedReservationId, attempt: 1 },
        signedTransaction: null,
      });
      expect((await post(request.public_token)).status).toBe(503);
      expect(await reservations()).toEqual(inProgress);
      expect(provider.signAsFeePayer).toHaveBeenCalledOnce();
    } finally {
      releaseSigning();
      ownerResponse = await owner;
    }
    expect(ownerResponse.status).toBe(200);
    const signedBytes = ((await ownerResponse.json()) as { transaction: string }).transaction;
    expect(await reservations()).toEqual([
      { id: ownedReservationId, status: "signed", attempt: 1, signed_transaction: signedBytes },
    ]);
    const replay = await post(request.public_token);
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { transaction: string }).transaction).toBe(signedBytes);
    expect(provider.signAsFeePayer).toHaveBeenCalledOnce();
  });

  it("refuses stale pre-effect linkage when a preceding writer replaces the expired payer and message window", async () => {
    const request = await createRequest();
    let releaseConfiguration = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseConfiguration = resolve;
    });
    let configurationRequested = () => {};
    const requested = new Promise<void>((resolve) => {
      configurationRequested = resolve;
    });
    provider.getSponsorshipConfiguration.mockImplementationOnce(async () => {
      configurationRequested();
      await gate;
      return TEST_SPONSORSHIP_PROVIDER_CONFIG;
    });
    const previousWriter = post(request.public_token);
    let previousResponse: Response | undefined;
    let replacementBytes: string | undefined;
    try {
      await Promise.race([
        requested,
        previousWriter.then(() => {
          throw new Error("Request completed before provider configuration");
        }),
      ]);
      const oldClaim = await repository().getSponsoredTransactionClaim(request.id);
      expect(oldClaim).not.toBeNull();
      const transfer = getTransferSolInstruction({
        source: createNoopSigner(address(TEST_SOLANA_ADDRESSES.wallet3)),
        destination: address(request.destination_address),
        amount: 1_500_000_000n,
      });
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (value) => setTransactionMessageFeePayer(TEST_MOCK_FEE_PAYER, value),
        (value) =>
          setTransactionMessageLifetimeUsingBlockhash(
            { blockhash: blockhash("1".repeat(32)), lastValidBlockHeight: 3000n },
            value
          ),
        (value) =>
          appendTransactionMessageInstructions(
            [
              {
                ...transfer,
                accounts: [
                  ...transfer.accounts,
                  { address: address(request.reference), role: AccountRole.READONLY },
                ],
              },
            ],
            value
          )
      );
      replacementBytes = getBase64Decoder().decode(
        getTransactionEncoder().encode(compileTransaction(message))
      );
      expect(
        await repository().claimSponsoredTransactionWindow({
          requestId: request.id,
          account: TEST_SOLANA_ADDRESSES.wallet3,
          unsignedTransaction: replacementBytes,
          lastValidBlockHeight: 3000n,
          currentBlockHeight: 2000n,
          deploymentMode: "managed",
          expectedClaim: oldClaim,
        })
      ).toBe(true);
    } finally {
      releaseConfiguration();
      previousResponse = await previousWriter;
    }
    expect(previousResponse.status).toBe(503);
    expect(provider.signAsFeePayer).not.toHaveBeenCalled();
    expect(await repository().getSponsoredTransactionClaim(request.id)).toEqual({
      account: TEST_SOLANA_ADDRESSES.wallet3,
      unsignedTransaction: replacementBytes,
      signedTransaction: null,
      lastValidBlockHeight: 3000n,
      deploymentMode: "managed",
      accountingIdentity: null,
    });
    expect(await reservations()).toEqual([
      { id: expect.any(String), status: "released", attempt: 1, signed_transaction: null },
    ]);
  });
});
