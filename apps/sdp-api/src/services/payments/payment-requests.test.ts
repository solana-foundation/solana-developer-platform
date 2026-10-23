import { runInClusterScope } from "@sdp/rpc/scope";
import * as verifiedConfirmation from "@sdp/rpc/verified-confirmation";
import { formatDecimalAmount } from "@sdp/solana/amount";
import { SOL_MINT, WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import {
  AccountRole,
  type Address,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createNoopSigner,
  createTransactionMessage,
  decodeTransactionFromRpcResponse,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  lamports,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signature,
  stringifiedBigInt,
  stringifiedNumber,
} from "@solana/kit";
import * as solanaPay from "@solana/pay";
import { FindReferenceError, ValidateTransferError } from "@solana/pay";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import { getDb } from "@/db/client";
import type { PaymentRequestRow } from "@/db/repositories/payment-requests.repository";
import {
  createPaymentRequestsRepository,
  createPaymentsRepository,
} from "@/db/repositories/repository-factory";
import { badRequest } from "@/lib/errors";
import { createTenantScope } from "@/lib/tenant-scope";
import { rootLogger } from "@/runtime/logger";
import * as paymentAmounts from "@/services/payments/token-amount";
import { TEST_CUSTODY_PUBLIC_KEY } from "@/test/fixtures/custody";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { installClusterRpcStub } from "@/test/helpers/cluster-rpc";
import { seedProjectCryptoWalletCounterparty } from "@/test/helpers/counterparties";
import { env } from "@/test/helpers/env";
import { BLANK_MANAGED_POOL_ENV } from "@/test/helpers/managed-pool-env";
import { syntheticAddress } from "@/test/helpers/parsed-transactions";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import * as paymentRequestTransfer from "./payment-request-transfer";
import { reconcilePaymentRequest } from "./payment-requests";

const TEST_PROJECT_ID = "prj_preq_handler_test";
const TEST_CONFIG_ID = "cust_cfg_preq_handler_test";
const TEST_CUSTODY_WALLET_ID = "cwlt_preq_handler_test";
const TEST_WALLET_ID = "wal_preq_handler_test";
const SIGNATURE = signature(getBase58Decoder().decode(new Uint8Array(64).fill(5)));
const DEVNET_USDC_MINT = WELL_KNOWN_TOKENS.USDC.mints.devnet.address;

const validateExactTransfer = paymentRequestTransfer.validatePaymentRequestTransfer;

let findReferenceSpy: MockInstance<typeof solanaPay.findReference>;
let validateTransferSpy: MockInstance<typeof paymentRequestTransfer.validatePaymentRequestTransfer>;
let verifyTransactionLandedSpy: MockInstance<typeof verifiedConfirmation.verifyTransactionLanded>;

function verifiedOk(): Awaited<ReturnType<typeof verifiedConfirmation.verifyTransactionLanded>> {
  return {
    ok: true,
    status: { slot: 1n, confirmations: 5n, confirmationStatus: "confirmed", err: null },
    transaction: {
      slot: 1n,
      accountKeys: [TEST_CUSTODY_PUBLIC_KEY],
      executionResultKnown: true,
      err: null,
      instructions: [],
    },
  };
}

function foundSignature(): Awaited<ReturnType<typeof solanaPay.findReference>> {
  return {
    signature: SIGNATURE,
    slot: 1n,
    err: null,
    memo: null,
    blockTime: null,
    confirmationStatus: "confirmed",
  };
}

async function validatedTransfer(
  token = SOL_MINT,
  rawAmount = token === SOL_MINT ? 1_500_000_000n : 1_500_000n,
  reference?: Address,
  lookupTable?: Address
): Promise<Awaited<ReturnType<typeof solanaPay.validateTransfer>>> {
  const owner = address(TEST_CUSTODY_PUBLIC_KEY);
  const source = createNoopSigner(syntheticAddress(332));
  const destination =
    token === SOL_MINT
      ? owner
      : (
          await findAssociatedTokenPda({
            owner,
            mint: address(token),
            tokenProgram: TOKEN_PROGRAM_ADDRESS,
          })
        )[0];
  const instruction =
    token === SOL_MINT
      ? getTransferSolInstruction({ source, destination, amount: rawAmount })
      : getTransferCheckedInstruction({
          source: syntheticAddress(333),
          mint: address(token),
          destination,
          authority: source,
          amount: rawAmount,
          decimals: 6,
        });
  const referenced =
    reference === undefined
      ? instruction
      : {
          ...instruction,
          accounts: [...instruction.accounts, { address: reference, role: AccountRole.READONLY }],
        };
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (message) => setTransactionMessageFeePayer(source.address, message),
    (message) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash(getBase58Decoder().decode(new Uint8Array(32).fill(7))),
          lastValidBlockHeight: 1n,
        },
        message
      ),
    (message) => appendTransactionMessageInstructions([referenced], message)
  );
  const transaction = compileTransaction(
    lookupTable === undefined
      ? message
      : compressTransactionMessageUsingAddressLookupTables(message, {
          [lookupTable]: [destination],
        })
  );
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const loadedWritable = lookupTable === undefined ? [] : [destination];
  const accountKeys = [...compiled.staticAccounts, ...loadedWritable];
  const accountIndex = accountKeys.indexOf(destination);
  const tokenBalance = (amount: bigint) => ({
    accountIndex,
    mint: address(token),
    owner,
    programId: TOKEN_PROGRAM_ADDRESS,
    uiTokenAmount: {
      amount: stringifiedBigInt(amount.toString()),
      decimals: 6,
      uiAmount: null,
      uiAmountString: stringifiedNumber(formatDecimalAmount(amount, 6)),
    },
  });
  return {
    slot: 1n,
    blockTime: null,
    version: 0,
    meta: {
      err: null,
      fee: lamports(5_000n),
      logMessages: [],
      preBalances: accountKeys.map(() => lamports(0n)),
      postBalances: accountKeys.map((account) =>
        lamports(token === SOL_MINT && account === destination ? rawAmount : 0n)
      ),
      preTokenBalances: token === SOL_MINT ? [] : [tokenBalance(0n)],
      postTokenBalances: token === SOL_MINT ? [] : [tokenBalance(rawAmount)],
      rewards: [],
      status: { Ok: null },
      loadedAddresses: { readonly: [], writable: loadedWritable },
    },
    transaction: [getBase64EncodedWireTransaction(transaction), "base64"],
  };
}

async function mockSettlementSucceeds(token = SOL_MINT) {
  findReferenceSpy.mockResolvedValue(foundSignature());
  verifyTransactionLandedSpy.mockResolvedValue(verifiedOk());
  validateTransferSpy.mockResolvedValue(await validatedTransfer(token));
}

async function createRequest(params: { token: string; expiresAt: string | null; amount?: string }) {
  return createPaymentRequestsRepository(
    env,
    createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID })
  ).createPaymentRequest({
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT_ID,
    custodyWalletId: TEST_CUSTODY_WALLET_ID,
    walletId: TEST_WALLET_ID,
    destinationAddress: TEST_CUSTODY_PUBLIC_KEY,
    token: params.token,
    amount: params.amount ?? "1.5",
    expiresAt: params.expiresAt,
    createdBy: TEST_USER.id,
  });
}

function reconcileOnSandbox(row: PaymentRequestRow, options: { bestEffort: boolean }) {
  return runInClusterScope({ projectId: TEST_PROJECT_ID, environment: "sandbox" }, () =>
    reconcilePaymentRequest(env, row, options)
  );
}

async function listInboundTransfers() {
  const result = await getDb(env)
    .prepare("SELECT * FROM payment_transfers WHERE wallet_id = ?")
    .bind(TEST_WALLET_ID)
    .all<Record<string, unknown>>();
  return result.results;
}

describe("reconcilePaymentRequest", () => {
  const rpc = installClusterRpcStub();

  beforeAll(async () => {
    await seedTestDatabase(env);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    findReferenceSpy = vi.spyOn(solanaPay, "findReference");
    validateTransferSpy = vi.spyOn(paymentRequestTransfer, "validatePaymentRequestTransfer");
    verifyTransactionLandedSpy = vi.spyOn(verifiedConfirmation, "verifyTransactionLanded");

    const db = getDb(env);
    await db.prepare("DELETE FROM payment_requests").run();
    await db.prepare("DELETE FROM payment_transfers").run();
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
    await db
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted,
            encryption_version, status)
         VALUES (?, ?, ?, 'local', 'test-config', 'sdp-custody-encryption-v1', 'active')`
      )
      .bind(TEST_CONFIG_ID, TEST_ORG.id, TEST_PROJECT_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, ?, ?, ?, 'active')`
      )
      .bind(TEST_CUSTODY_WALLET_ID, TEST_CONFIG_ID, TEST_WALLET_ID, TEST_CUSTODY_PUBLIC_KEY)
      .run();
  });

  it("settles an awaiting request and links an inbound transfer attributed to no counterparty", async () => {
    await mockSettlementSucceeds();
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });
    await seedProjectCryptoWalletCounterparty(getDb(env), {
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      createdBy: TEST_USER.id,
      counterpartyId: "cp_preq_handler_legacy_payer",
      counterpartyAccountId: "cpa_preq_handler_legacy_payer",
      walletAddress: TEST_SOLANA_ADDRESSES.wallet1,
    });
    await getDb(env)
      .prepare("UPDATE payment_requests SET counterparty_id = ? WHERE id = ?")
      .bind("cp_preq_handler_legacy_payer", request.id)
      .run();

    const settled = await reconcileOnSandbox(request, { bestEffort: false });

    expect(settled.status).toBe("paid");
    expect(settled.fulfilled_by_transfer_id).not.toBeNull();

    const transfers = await listInboundTransfers();
    expect(transfers).toHaveLength(1);
    expect(transfers[0].id).toBe(settled.fulfilled_by_transfer_id);
    expect(transfers[0].direction).toBe("inbound");
    expect(transfers[0].status).toBe("confirmed");
    expect(transfers[0].signature).toBe(SIGNATURE);
    expect(transfers[0].custody_wallet_id).toBe(TEST_CUSTODY_WALLET_ID);
    expect(transfers[0].counterparty_id).toBeNull();
  });

  it("settles an SPL request, exercising the splToken branch", async () => {
    await mockSettlementSucceeds(DEVNET_USDC_MINT);

    const settled = await reconcileOnSandbox(
      await createRequest({ token: DEVNET_USDC_MINT, expiresAt: null }),
      {
        bestEffort: false,
      }
    );

    expect(settled.status).toBe("paid");
    const fields = validateTransferSpy.mock.calls[0][1];
    expect(fields.splToken).toBe(DEVNET_USDC_MINT);
  });

  it.each([
    {
      label: "legacy excessive precision",
      token: DEVNET_USDC_MINT,
      amount: "1.0000001",
      received: 1_000_000n,
      status: "awaiting_payment",
    },
    {
      label: "exact SPL above 2^53",
      token: DEVNET_USDC_MINT,
      amount: "9007199254.740993",
      received: 9007199254740993n,
      status: "paid",
    },
    {
      label: "one raw unit short above 2^53",
      token: DEVNET_USDC_MINT,
      amount: "9007199254.740993",
      received: 9007199254740992n,
      status: "awaiting_payment",
    },
    {
      label: "one lamport short",
      token: SOL_MINT,
      amount: "1.5",
      received: 1_499_999_999n,
      status: "awaiting_payment",
    },
  ])("checks $label with real transfer validation", async ({ token, amount, received, status }) => {
    const request = await createRequest({ token, amount, expiresAt: null });
    findReferenceSpy.mockResolvedValue(foundSignature());
    verifyTransactionLandedSpy.mockResolvedValue(verifiedOk());
    validateTransferSpy.mockImplementation(validateExactTransfer);
    const response = await validatedTransfer(token, received, address(request.reference));
    // JSON-RPC token amounts are strings; all numeric fixture metadata is small.
    rpc.answer(
      "getTransaction",
      JSON.parse(
        JSON.stringify(response, (_, value) => (typeof value === "bigint" ? Number(value) : value))
      )
    );
    const settled = await reconcileOnSandbox(request, { bestEffort: false });
    expect(settled.status).toBe(status);
    expect(await listInboundTransfers()).toHaveLength(status === "paid" ? 1 : 0);
  });

  it.each([
    { received: 1_500_000n, status: "paid" },
    { received: 1_499_999n, status: "awaiting_payment" },
  ])(
    "settles only sufficient payments into a fresh ATA: $received",
    async ({ received, status }) => {
      const request = await createRequest({ token: DEVNET_USDC_MINT, expiresAt: null });
      findReferenceSpy.mockResolvedValue(foundSignature());
      verifyTransactionLandedSpy.mockResolvedValue(verifiedOk());
      validateTransferSpy.mockImplementation(validateExactTransfer);
      const response = await validatedTransfer(
        DEVNET_USDC_MINT,
        received,
        address(request.reference)
      );
      if (response.meta === null) throw new Error("Fixture requires metadata");
      const fresh = { ...response, meta: { ...response.meta, preTokenBalances: [] } };
      rpc.answer(
        "getTransaction",
        JSON.parse(
          JSON.stringify(fresh, (_, value) => (typeof value === "bigint" ? Number(value) : value))
        )
      );
      expect((await reconcileOnSandbox(request, { bestEffort: false })).status).toBe(status);
      expect(await listInboundTransfers()).toHaveLength(status === "paid" ? 1 : 0);
    }
  );

  it.each(["wrong program", "wrong mint", "wrong decimals", "failed transaction"])(
    "rejects a fresh ATA payment with %s",
    async (fault) => {
      const request = await createRequest({ token: DEVNET_USDC_MINT, expiresAt: null });
      findReferenceSpy.mockResolvedValue(foundSignature());
      verifyTransactionLandedSpy.mockResolvedValue(verifiedOk());
      validateTransferSpy.mockImplementation(validateExactTransfer);
      const response = await validatedTransfer(
        fault === "wrong program" ? SOL_MINT : DEVNET_USDC_MINT,
        1_500_000n,
        address(request.reference)
      );
      if (response.meta === null) throw new Error("Fixture requires metadata");
      const postTokenBalances = response.meta.postTokenBalances?.map((balance) => ({
        ...balance,
        mint: fault === "wrong mint" ? syntheticAddress(502) : balance.mint,
        uiTokenAmount: {
          ...balance.uiTokenAmount,
          decimals: fault === "wrong decimals" ? 5 : balance.uiTokenAmount.decimals,
        },
      }));
      const invalid = {
        ...response,
        meta: {
          ...response.meta,
          preTokenBalances: [],
          postTokenBalances,
          err: fault === "failed transaction" ? { InstructionError: [0, "InvalidArgument"] } : null,
        },
      };
      rpc.answer(
        "getTransaction",
        JSON.parse(
          JSON.stringify(invalid, (_, value) => (typeof value === "bigint" ? Number(value) : value))
        )
      );
      expect((await reconcileOnSandbox(request, { bestEffort: false })).status).toBe(
        "awaiting_payment"
      );
      expect(await listInboundTransfers()).toHaveLength(0);
    }
  );

  it("settles an SPL payment whose recipient ATA loads from an address lookup table", async () => {
    const request = await createRequest({ token: DEVNET_USDC_MINT, expiresAt: null });
    findReferenceSpy.mockResolvedValue(foundSignature());
    verifyTransactionLandedSpy.mockResolvedValue(verifiedOk());
    validateTransferSpy.mockImplementation(validateExactTransfer);
    const response = await validatedTransfer(
      DEVNET_USDC_MINT,
      1_500_000n,
      address(request.reference),
      syntheticAddress(335)
    );
    const [recipientAta] = await findAssociatedTokenPda({
      owner: address(TEST_CUSTODY_PUBLIC_KEY),
      mint: address(DEVNET_USDC_MINT),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const { compiledMessage, loadedAddresses } = decodeTransactionFromRpcResponse(response);
    expect(compiledMessage.staticAccounts).not.toContain(recipientAta);
    expect(loadedAddresses).toEqual({ readonly: [], writable: [recipientAta] });
    rpc.answer(
      "getTransaction",
      JSON.parse(
        JSON.stringify(response, (_, value) => (typeof value === "bigint" ? Number(value) : value))
      )
    );
    expect((await reconcileOnSandbox(request, { bestEffort: false })).status).toBe("paid");
    expect(await listInboundTransfers()).toHaveLength(1);
  });

  it("still rejects a transfer whose reference does not match the request", async () => {
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });
    findReferenceSpy.mockResolvedValue(foundSignature());
    verifyTransactionLandedSpy.mockResolvedValue(verifiedOk());
    validateTransferSpy.mockImplementation(validateExactTransfer);
    const response = await validatedTransfer(SOL_MINT, 1_500_000_000n, syntheticAddress(334));
    rpc.answer(
      "getTransaction",
      JSON.parse(
        JSON.stringify(response, (_, value) => (typeof value === "bigint" ? Number(value) : value))
      )
    );
    expect((await reconcileOnSandbox(request, { bestEffort: false })).status).toBe(
      "awaiting_payment"
    );
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it("converges concurrent reconciles of the same request to a single settlement", async () => {
    await mockSettlementSucceeds();
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });

    const [a, b] = await Promise.all([
      reconcileOnSandbox(request, { bestEffort: false }),
      reconcileOnSandbox(request, { bestEffort: false }),
    ]);

    expect(a.status).toBe("paid");
    expect(b.status).toBe("paid");
    expect(await listInboundTransfers()).toHaveLength(1);
  });

  it("does not link a request to a conflicting transfer with the same signature", async () => {
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });
    const transfer = await createPaymentsRepository(
      env,
      createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID })
    ).createTransfer({
      id: "xfr_conflicting_signature",
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      custodyWalletId: TEST_CUSTODY_WALLET_ID,
      walletId: TEST_WALLET_ID,
      counterpartyId: null,
      sourceAddress: null,
      destinationAddress: TEST_CUSTODY_PUBLIC_KEY,
      token: SOL_MINT,
      amount: "1.5",
      memo: null,
      type: "transfer",
      direction: "inbound",
      status: "confirmed",
      provider: null,
      providerReference: null,
      deliveryMode: null,
      fiatCurrency: null,
      fiatAmount: null,
      providerData: {},
      serializedTx: null,
      signature: SIGNATURE,
      slot: 1,
      initiatedByKeyId: null,
    });
    if (!transfer) throw new Error("Expected conflicting transfer fixture creation to succeed");
    await getDb(env)
      .prepare("UPDATE payment_transfers SET custody_wallet_id = NULL WHERE id = ?")
      .bind(transfer.id)
      .run();
    await mockSettlementSucceeds();

    await expect(reconcileOnSandbox(request, { bestEffort: false })).rejects.toThrow(
      "does not match payment request"
    );
    expect(await listInboundTransfers()).toMatchObject([{ custody_wallet_id: null }]);
  });

  it("does not settle when the signature fails the independent confirmation check", async () => {
    findReferenceSpy.mockResolvedValue(foundSignature());
    verifyTransactionLandedSpy.mockResolvedValue({ ok: false, reason: "not_confirmed" });
    validateTransferSpy.mockResolvedValue(await validatedTransfer());

    const result = await reconcileOnSandbox(
      await createRequest({ token: SOL_MINT, expiresAt: null }),
      {
        bestEffort: false,
      }
    );

    expect(result.status).toBe("awaiting_payment");
    expect(validateTransferSpy).not.toHaveBeenCalled();
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it("does not settle while the transaction is confirmed but not yet indexed", async () => {
    findReferenceSpy.mockResolvedValue(foundSignature());
    verifyTransactionLandedSpy.mockResolvedValue({ ok: false, reason: "not_indexed" });

    const result = await reconcileOnSandbox(
      await createRequest({ token: SOL_MINT, expiresAt: null }),
      {
        bestEffort: false,
      }
    );

    expect(result.status).toBe("awaiting_payment");
    expect(validateTransferSpy).not.toHaveBeenCalled();
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it("leaves the request awaiting when no transfer references it", async () => {
    findReferenceSpy.mockRejectedValue(new FindReferenceError("not found"));

    const result = await reconcileOnSandbox(
      await createRequest({ token: SOL_MINT, expiresAt: null }),
      { bestEffort: false }
    );

    expect(result.status).toBe("awaiting_payment");
    expect(result.fulfilled_by_transfer_id).toBeNull();
    expect(validateTransferSpy).not.toHaveBeenCalled();
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it("leaves the request awaiting when the referenced transfer is invalid", async () => {
    findReferenceSpy.mockResolvedValue(foundSignature());
    verifyTransactionLandedSpy.mockResolvedValue(verifiedOk());
    validateTransferSpy.mockRejectedValue(new ValidateTransferError("wrong amount"));

    const result = await reconcileOnSandbox(
      await createRequest({ token: SOL_MINT, expiresAt: null }),
      { bestEffort: false }
    );

    expect(result.status).toBe("awaiting_payment");
    expect(result.fulfilled_by_transfer_id).toBeNull();
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it("rethrows unexpected errors instead of swallowing them", async () => {
    findReferenceSpy.mockRejectedValue(new Error("rpc exploded"));

    await expect(
      reconcileOnSandbox(await createRequest({ token: SOL_MINT, expiresAt: null }), {
        bestEffort: false,
      })
    ).rejects.toThrow("rpc exploded");
  });

  it.each([
    "Token mint account does not exist",
    "Unsupported token program for mint",
    "Payments do not support the InterestBearingConfig mint extension",
  ])("isolates legacy mint rejection from other list rows: %s", async (message) => {
    const warn = vi.spyOn(rootLogger, "warn").mockImplementation(() => {});
    const invalidMint = syntheticAddress(501);
    const loadPaymentMint = paymentAmounts.loadPaymentMint;
    vi.spyOn(paymentAmounts, "loadPaymentMint").mockImplementation((mint) =>
      mint === invalidMint ? Promise.reject(badRequest(message)) : loadPaymentMint(mint)
    );
    const invalid = await createRequest({ token: invalidMint, expiresAt: null });
    const healthy = await createRequest({ token: SOL_MINT, expiresAt: null });
    await mockSettlementSucceeds();
    const [unchanged, settled] = await Promise.all(
      [invalid, healthy].map((row) => reconcileOnSandbox(row, { bestEffort: true }))
    );
    expect(unchanged).toEqual(invalid);
    expect(settled.status).toBe("paid");
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ payment_request_id: invalid.id, reason: "mint_not_admitted" }),
      expect.any(String)
    );
    expect(await listInboundTransfers()).toHaveLength(1);
  });

  it("best-effort returns the stored row and logs when reconcile errors unexpectedly", async () => {
    const errorSpy = vi.spyOn(rootLogger, "error").mockImplementation(() => {});
    findReferenceSpy.mockRejectedValue(new Error("rpc exploded"));
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });

    const result = await reconcileOnSandbox(request, { bestEffort: true });

    expect(result).toBe(request);
    expect(errorSpy).toHaveBeenCalled();
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it("best-effort rethrows RPC_NOT_CONFIGURED instead of degrading to the stored row", async () => {
    const errorSpy = vi.spyOn(rootLogger, "error").mockImplementation(() => {});
    for (const [envKey, blankValue] of Object.entries(BLANK_MANAGED_POOL_ENV)) {
      vi.stubEnv(envKey, blankValue);
    }
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });

    await expect(reconcileOnSandbox(request, { bestEffort: true })).rejects.toMatchObject({
      name: "SdpRpcError",
      code: "RPC_NOT_CONFIGURED",
      details: { cluster: "devnet" },
    });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(findReferenceSpy).not.toHaveBeenCalled();
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it("returns an unresolved legacy request on best-effort reads without touching the chain", async () => {
    const request: PaymentRequestRow = {
      ...(await createRequest({ token: SOL_MINT, expiresAt: null })),
      custody_wallet_id: null,
    };

    const result = await reconcileOnSandbox(request, { bestEffort: true });

    expect(result).toBe(request);
    expect(findReferenceSpy).not.toHaveBeenCalled();
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it("rejects an unresolved legacy request when current state is required", async () => {
    const request: PaymentRequestRow = {
      ...(await createRequest({ token: SOL_MINT, expiresAt: null })),
      custody_wallet_id: null,
    };

    await expect(reconcileOnSandbox(request, { bestEffort: false })).rejects.toMatchObject({
      code: "CONFLICT",
      statusCode: 409,
    });
    expect(findReferenceSpy).not.toHaveBeenCalled();
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it("short-circuits non-awaiting requests without touching the chain", async () => {
    const canceled: PaymentRequestRow = {
      ...(await createRequest({ token: SOL_MINT, expiresAt: null })),
      status: "canceled",
    };

    const result = await reconcileOnSandbox(canceled, { bestEffort: false });

    expect(result).toBe(canceled);
    expect(findReferenceSpy).not.toHaveBeenCalled();
  });

  it("short-circuits expired requests without touching the chain", async () => {
    const expired = await createRequest({ token: SOL_MINT, expiresAt: "2000-01-01T00:00:00.000Z" });

    const result = await reconcileOnSandbox(expired, { bestEffort: false });

    expect(result.status).toBe("awaiting_payment");
    expect(findReferenceSpy).not.toHaveBeenCalled();
  });
});
