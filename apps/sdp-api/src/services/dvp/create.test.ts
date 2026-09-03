/**
 * The create path's safety order: build, sign, record, send.
 *
 * The claim under test is an ORDERING claim, so these tests read the real
 * database from inside the mocked `sendTransaction`. Asserting on call order
 * with spies would only prove the mocks ran in a sequence; reading the row back
 * proves it was durable at the moment the bytes went out, which is the property
 * that makes a crash there recoverable.
 *
 * The consequence of getting it wrong is not a lost record. `RecoverDvp`
 * re-derives the escrow from the six seed values, a retry draws a fresh nonce
 * and lands somewhere else, so an on-chain trade with no row is a customer's
 * deposit that nobody can ever rescue (EXO-216/217).
 */

import {
  address,
  type Blockhash,
  getBase58Codec,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SolanaError,
} from "@solana/kit";
import { generateKeyPairSigner } from "@solana/signers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";

const createOrgSignerForCustodyWallet = vi.hoisted(() => vi.fn());
const sendTransaction = vi.hoisted(() => vi.fn());
// The mint pre-flight is verified separately against real devnet mints in
// mints.test.ts; here it is stubbed so these tests stay about broadcast
// ordering. The last case below still proves create is wired to it.
const validateDvpMints = vi.hoisted(() => vi.fn());

vi.mock("@/services/solana/signer", () => ({ createOrgSignerForCustodyWallet }));
vi.mock("./mints", () => ({ validateDvpMints }));
vi.mock("@sdp/rpc/solana", () => ({
  createRpc: () => ({}),
  getRecentBlockhash: async () => ({
    blockhash: getBase58Codec().decode(new Uint8Array(32).fill(7)) as Blockhash,
    lastValidBlockHeight: 100n,
  }),
  sendTransaction,
}));

const { createDvpTrade } = await import("./create");

const TEST_PROJECT_ID = "prj_dvp_create_test";
const CUSTODY_CONFIG_ID = "cust_dvp_create_test";
const CUSTODY_WALLET_ID = "cwlt_dvp_create_test";

// Distinct from both parties, which `validateDvpTerms` requires.
const SETTLEMENT_AUTHORITY = "9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY";
const COUNTERPARTY = "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg";

function tradeInput() {
  return {
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT_ID,
    sdpWalletId: CUSTODY_WALLET_ID,
    sdpSide: "a" as const,
    counterparty: COUNTERPARTY,
    mintA: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1",
    tokenProgramA: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    mintB: "AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE",
    tokenProgramB: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    amountA: 1000n,
    amountB: 2000n,
    expiryTimestamp: BigInt(Math.floor(Date.now() / 1000) + 3600),
    earliestSettlementTimestamp: null,
    refString: null,
  };
}

/** Reads every trade row straight out of Postgres, bypassing the repository. */
async function rowsInDb(): Promise<{ id: string; status: string; nonce: string }[]> {
  const result = await getDb(env)
    .prepare("SELECT id, status, nonce FROM dvp_trades")
    .all<{ id: string; status: string; nonce: string }>();
  return result.results ?? [];
}

describe("createDvpTrade", () => {
  let originalSettlementAuthority: string | undefined;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    validateDvpMints.mockResolvedValue([]);
    originalSettlementAuthority = env.DVP_SETTLEMENT_AUTHORITY;
    env.DVP_SETTLEMENT_AUTHORITY = SETTLEMENT_AUTHORITY;

    const db = getDb(env);
    await db.prepare("DELETE FROM dvp_trades").run();
    await db.prepare("DELETE FROM custody_wallets").run();
    await db.prepare("DELETE FROM custody_configs").run();
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
         VALUES (?, ?, 'Test Project', ?, 'sandbox', 'active', ?)`
      )
      .bind(TEST_PROJECT_ID, TEST_ORG.id, TEST_PROJECT_ID, TEST_USER.id)
      .run();
    await db
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, provider, config_encrypted, status)
         VALUES (?, ?, 'local', 'x', 'active')`
      )
      .bind(CUSTODY_CONFIG_ID, TEST_ORG.id)
      .run();

    // A real signer, so the transaction is really signed and the signature the
    // row carries is the one the network would see.
    const signer = await generateKeyPairSigner();
    createOrgSignerForCustodyWallet.mockResolvedValue(signer);

    await db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, ?, 'w1', ?, 'active')`
      )
      .bind(CUSTODY_WALLET_ID, CUSTODY_CONFIG_ID, signer.address)
      .run();
  });

  afterEach(() => {
    env.DVP_SETTLEMENT_AUTHORITY = originalSettlementAuthority;
  });

  it("has the trade durably recorded at `creating` before the bytes go out", async () => {
    let rowsAtSendTime: Awaited<ReturnType<typeof rowsInDb>> = [];
    sendTransaction.mockImplementation(async () => {
      rowsAtSendTime = await rowsInDb();
      return "sig";
    });

    const trade = await createDvpTrade(env, tradeInput());

    expect(sendTransaction).toHaveBeenCalledTimes(1);
    expect(rowsAtSendTime).toHaveLength(1);
    expect(rowsAtSendTime[0].status).toBe("creating");
    expect(rowsAtSendTime[0].id).toBe(trade.id);
    // The nonce is the seed that makes the row recoverable at all.
    expect(rowsAtSendTime[0].nonce).toBe(trade.nonce);
  });

  it("advances the trade to created once the broadcast is accepted", async () => {
    sendTransaction.mockResolvedValue("sig");

    const trade = await createDvpTrade(env, tradeInput());

    expect(trade.status).toBe("created");
    expect(trade.createSignature).toBeTruthy();
    await expect(rowsInDb()).resolves.toMatchObject([{ status: "created" }]);
  });

  // A preflight failure is the one send error the RPC guarantees never reached
  // the network, so it is safe to call terminal.
  it("marks the trade create_failed when the RPC rejects it in preflight", async () => {
    // A real SolanaError carrying the real preflight code, so the classification
    // under test runs against the same `isSolanaError` check production does
    // rather than against a shape this test invented.
    sendTransaction.mockRejectedValue(
      new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {
        accounts: null,
        fee: null,
        loadedAccountsDataSize: 0,
        loadedAddresses: null,
        logs: ["Program dvp34bdbcEm4f4FCUjGV4mDAkDshaQR4LkK8fdcsyZq failed: custom error 0x5"],
        postBalances: null,
        postTokenBalances: null,
        preBalances: null,
        preTokenBalances: null,
        replacementBlockhash: null,
        returnData: null,
        unitsConsumed: 0n,
      })
    );

    await expect(createDvpTrade(env, tradeInput())).rejects.toThrow();

    const rows = await rowsInDb();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("create_failed");
  });

  // The dangerous case. A timeout does NOT mean the transaction failed — it may
  // still land — so marking it failed would tell us a trade does not exist while
  // its escrow sits on chain waiting for a deposit.
  it("leaves an ambiguously failed send at creating rather than guessing", async () => {
    sendTransaction.mockRejectedValue(new Error("socket hang up"));

    await expect(createDvpTrade(env, tradeInput())).rejects.toThrow("socket hang up");

    const rows = await rowsInDb();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("creating");
  });

  // The pre-flight has to run BEFORE anything is signed or written. A mint the
  // program refuses would otherwise cost a signature and leave a create_failed
  // row behind for a request that could have been a plain 400.
  it("refuses a mint the program would reject, before signing or writing", async () => {
    validateDvpMints.mockResolvedValue([
      "mintA carries the ScaledUiAmountConfig extension, which DvP settlement refuses",
    ]);

    await expect(createDvpTrade(env, tradeInput())).rejects.toThrow(/ScaledUiAmountConfig/);

    expect(createOrgSignerForCustodyWallet).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
    await expect(rowsInDb()).resolves.toEqual([]);
  });

  it("writes nothing when the terms are refused before signing", async () => {
    await expect(
      createDvpTrade(env, { ...tradeInput(), counterparty: address(SETTLEMENT_AUTHORITY) })
    ).rejects.toThrow(/settlementAuthority must not be/);

    expect(sendTransaction).not.toHaveBeenCalled();
    await expect(rowsInDb()).resolves.toEqual([]);
  });
});
