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
// The settlement wallet is a per-project custody wallet provisioned on first
// use. Its own behaviour is covered in settlement-wallet.test.ts; here it is
// stubbed so these tests stay about broadcast ordering.
const getOrCreateDvpSettlementWallet = vi.hoisted(() => vi.fn());

vi.mock("@/services/solana/signer", () => ({ createOrgSignerForCustodyWallet }));
vi.mock("./mints", () => ({ validateDvpMints }));
vi.mock("./settlement-wallet", () => ({ getOrCreateDvpSettlementWallet }));
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
    idempotencyKey: null,
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
    getOrCreateDvpSettlementWallet.mockResolvedValue({
      custodyWalletId: "cwlt_settlement",
      address: SETTLEMENT_AUTHORITY,
    });
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

  // A retry after an ambiguous broadcast must return the ORIGINAL trade. Create
  // draws a fresh nonce every time, so without this the retry lands at a
  // different address and the first trade sits on chain with a published escrow
  // nobody is watching.
  it("returns the original trade when a keyed request is retried", async () => {
    sendTransaction.mockResolvedValue("sig");
    const input = { ...tradeInput(), idempotencyKey: "key-1" };

    const first = await createDvpTrade(env, input);
    const retried = await createDvpTrade(env, input);

    expect(retried.id).toBe(first.id);
    expect(retried.swapDvp).toBe(first.swapDvp);
    // The retry must not broadcast a second transaction.
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    await expect(rowsInDb()).resolves.toHaveLength(1);
  });

  // A create that definitively never landed leaves its logical request unmade,
  // so the key it claimed has nothing to answer for. Replaying it hands back a
  // dead trade instead — and for a caller whose key is DERIVED from the payload,
  // as the dashboard's is, that is permanent: there is no other key it can send
  // for those terms, so one preflight rejection would retire the trade forever.
  describe("after a create that definitively failed", () => {
    async function failOnceWith(key: string) {
      sendTransaction.mockRejectedValueOnce(
        new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {
          accounts: null,
          fee: null,
          loadedAccountsDataSize: 0,
          loadedAddresses: null,
          logs: [],
          postBalances: null,
          postTokenBalances: null,
          preBalances: null,
          preTokenBalances: null,
          replacementBlockhash: null,
          returnData: null,
          unitsConsumed: 0n,
        })
      );
      await expect(
        createDvpTrade(env, { ...tradeInput(), idempotencyKey: key })
      ).rejects.toThrow();
    }

    it("lets the same key create the trade on a retry", async () => {
      await failOnceWith("key-retry");
      sendTransaction.mockResolvedValue("sig");

      const retried = await createDvpTrade(env, { ...tradeInput(), idempotencyKey: "key-retry" });

      expect(retried.status).toBe("created");
    });

    it("keeps the failed attempt on the record rather than deleting it", async () => {
      await failOnceWith("key-retry");
      sendTransaction.mockResolvedValue("sig");

      await createDvpTrade(env, { ...tradeInput(), idempotencyKey: "key-retry" });

      const rows = await rowsInDb();
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.status).sort()).toEqual(["create_failed", "created"]);
    });

    // Freed on the dead row only. Leaving it there would let a second retry
    // replay the corpse again.
    it("frees the key from the failed row so only the live trade answers to it", async () => {
      await failOnceWith("key-retry");
      sendTransaction.mockResolvedValue("sig");
      const live = await createDvpTrade(env, { ...tradeInput(), idempotencyKey: "key-retry" });

      const replayed = await createDvpTrade(env, { ...tradeInput(), idempotencyKey: "key-retry" });

      expect(replayed.id).toBe(live.id);
      await expect(rowsInDb()).resolves.toHaveLength(2);
    });
  });

  // An AMBIGUOUS failure is the opposite case: the transaction may still land,
  // so its key must keep answering or the retry would create a second trade at
  // a second address while the first sits on chain.
  it("does not free the key of a trade still stuck at creating", async () => {
    sendTransaction.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(
      createDvpTrade(env, { ...tradeInput(), idempotencyKey: "key-ambiguous" })
    ).rejects.toThrow("socket hang up");

    sendTransaction.mockResolvedValue("sig");
    const retried = await createDvpTrade(env, {
      ...tradeInput(),
      idempotencyKey: "key-ambiguous",
    });

    expect(retried.status).toBe("creating");
    await expect(rowsInDb()).resolves.toHaveLength(1);
  });

  // A key is a claim, not a proof. Reused with different terms it would hand
  // back the earlier trade — and that trade names a custody wallet and
  // publishes escrow addresses, so a wallet-scoped caller would receive a
  // wallet and escrows outside their own scope.
  it("refuses a key reused with different terms", async () => {
    sendTransaction.mockResolvedValue("sig");
    await createDvpTrade(env, { ...tradeInput(), idempotencyKey: "key-1" });

    await expect(
      createDvpTrade(env, { ...tradeInput(), idempotencyKey: "key-1", amountA: 999n })
    ).rejects.toThrow(/different request payload/);
  });

  // sdpWalletId is in the fingerprint precisely so a key cannot be used to
  // reach a trade belonging to another wallet.
  it("refuses a key reused against a different custody wallet", async () => {
    sendTransaction.mockResolvedValue("sig");
    await createDvpTrade(env, { ...tradeInput(), idempotencyKey: "key-1" });

    await expect(
      createDvpTrade(env, {
        ...tradeInput(),
        idempotencyKey: "key-1",
        sdpWalletId: "cwlt_someone_else",
      })
    ).rejects.toThrow(/different request payload/);
  });

  // Two overlapping retries both miss the lookup and both reach the insert. The
  // unique index rejects one, and without recovery that retry gets a 500 —
  // exactly the case the key exists to make safe.
  it("replays rather than failing when two keyed requests race", async () => {
    sendTransaction.mockResolvedValue("sig");
    const input = { ...tradeInput(), idempotencyKey: "key-race" };

    const [first, second] = await Promise.all([
      createDvpTrade(env, input),
      createDvpTrade(env, input),
    ]);

    expect(second.id).toBe(first.id);
    await expect(rowsInDb()).resolves.toHaveLength(1);
    // The loser must not broadcast a second transaction for the same trade.
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("creates separate trades for different keys", async () => {
    sendTransaction.mockResolvedValue("sig");

    const first = await createDvpTrade(env, { ...tradeInput(), idempotencyKey: "key-a" });
    const second = await createDvpTrade(env, { ...tradeInput(), idempotencyKey: "key-b" });

    expect(second.id).not.toBe(first.id);
    expect(sendTransaction).toHaveBeenCalledTimes(2);
  });

  // Without a key there is nothing to replay against, so each call is a new
  // trade — which is exactly why the key matters on a retry.
  it("creates a new trade every time when no key is sent", async () => {
    sendTransaction.mockResolvedValue("sig");

    const first = await createDvpTrade(env, tradeInput());
    const second = await createDvpTrade(env, tradeInput());

    expect(second.id).not.toBe(first.id);
  });

  it("writes nothing when the terms are refused before signing", async () => {
    await expect(
      createDvpTrade(env, { ...tradeInput(), counterparty: address(SETTLEMENT_AUTHORITY) })
    ).rejects.toThrow(/settlementAuthority must not be/);

    expect(sendTransaction).not.toHaveBeenCalled();
    await expect(rowsInDb()).resolves.toEqual([]);
  });
});
