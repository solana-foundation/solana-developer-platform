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
const inspectDvpMint = vi.hoisted(() => vi.fn());
// The settlement wallet is a per-project custody wallet provisioned on first
// use. Its own behaviour is covered in settlement-wallet.test.ts; here it is
// stubbed so these tests stay about broadcast ordering.
const getOrCreateDvpSettlementWallet = vi.hoisted(() => vi.fn());

vi.mock("@/services/solana/signer", () => ({ createOrgSignerForCustodyWallet }));
vi.mock("./mints", () => ({ validateDvpMints }));
vi.mock("./inspect-mint", () => ({ inspectDvpMint }));
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
const TEST_PROJECT_ID_OTHER = "prj_dvp_create_other";
const CUSTODY_CONFIG_ID = "cust_dvp_create_test";
const CUSTODY_WALLET_ID = "cwlt_dvp_create_test";

// Distinct from both parties, which `validateDvpTerms` requires.
const SETTLEMENT_AUTHORITY = "9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY";
const COUNTERPARTY_ADDRESS = "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg";

function tradeInput() {
  return {
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT_ID,
    partyA: { walletId: CUSTODY_WALLET_ID },
    partyB: { address: address(COUNTERPARTY_ADDRESS) },
    payerWalletId: null,
    mintA: address("ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1"),
    tokenProgramA: address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
    mintB: address("AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE"),
    tokenProgramB: address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
    amountA: 1000n,
    amountB: 2000n,
    expiryTimestamp: BigInt(Math.floor(Date.now() / 1000) + 3600),
    earliestSettlementTimestamp: null,
    refString: null,
    // Null is the ordinary trade: the program records each party's own address.
    // Custom destinations are covered in their own cases below.
    userASettlementDestination: null,
    userBSettlementDestination: null,
    idempotencyKey: null,
  };
}

/** Reads every trade row straight out of Postgres, bypassing the repository. */
async function rowsInDb(): Promise<
  {
    id: string;
    status: string;
    nonce: string;
    counterparty_account_id_a: string | null;
    counterparty_account_id_b: string | null;
  }[]
> {
  const result = await getDb(env)
    .prepare(
      "SELECT id, status, nonce, counterparty_account_id_a, counterparty_account_id_b FROM dvp_trades"
    )
    .all<{
      id: string;
      status: string;
      nonce: string;
      counterparty_account_id_a: string | null;
      counterparty_account_id_b: string | null;
    }>();
  return result.results ?? [];
}

describe("createDvpTrade", () => {
  let custodyWalletAddress: string;
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
    // Carried onto the row so later surfaces can show the trade in the units
    // somebody typed, with the token named.
    inspectDvpMint.mockResolvedValue({ decimals: 6, symbol: "ATD" });
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
         VALUES (?, ?, 'Test Project', ?, 'sandbox', 'active', ?)`
      )
      .bind(TEST_PROJECT_ID, TEST_ORG.id, TEST_PROJECT_ID, TEST_USER.id)
      .run();
    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Other Project', ?, 'sandbox', 'active', ?)`
      )
      .bind(TEST_PROJECT_ID_OTHER, TEST_ORG.id, TEST_PROJECT_ID_OTHER, TEST_USER.id)
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
    custodyWalletAddress = signer.address;
    createOrgSignerForCustodyWallet.mockResolvedValue(signer);

    await db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, ?, 'w1', ?, 'active')`
      )
      .bind(CUSTODY_WALLET_ID, CUSTODY_CONFIG_ID, custodyWalletAddress)
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
      await expect(createDvpTrade(env, { ...tradeInput(), idempotencyKey: key })).rejects.toThrow();
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
  // back the earlier trade — and that trade publishes escrow addresses, so a
  // wallet-scoped caller would receive escrows outside their own scope.
  it("refuses a key reused with different terms", async () => {
    sendTransaction.mockResolvedValue("sig");
    await createDvpTrade(env, { ...tradeInput(), idempotencyKey: "key-1" });

    await expect(
      createDvpTrade(env, { ...tradeInput(), idempotencyKey: "key-1", amountA: 999n })
    ).rejects.toThrow(/different request payload/);
  });

  // payerWalletId is in the fingerprint as sent, so a key reused against a
  // different payer is a different request.
  it("refuses a key reused against a different payer wallet", async () => {
    sendTransaction.mockResolvedValue("sig");
    await createDvpTrade(env, { ...tradeInput(), idempotencyKey: "key-1" });

    await expect(
      createDvpTrade(env, {
        ...tradeInput(),
        idempotencyKey: "key-1",
        payerWalletId: "cwlt_some_other_payer",
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
      createDvpTrade(env, {
        ...tradeInput(),
        partyB: { address: address(SETTLEMENT_AUTHORITY) },
      })
    ).rejects.toThrow(/settlementAuthority must not be/);

    expect(sendTransaction).not.toHaveBeenCalled();
    await expect(rowsInDb()).resolves.toEqual([]);
  });

  // A `{ walletId }` slot resolves to the wallet's address and stores NULL
  // attribution — fundability re-derives later, never from a stored column.
  it("resolves a walletId slot to the wallet's address and stores null attribution", async () => {
    sendTransaction.mockResolvedValue("sig");

    const trade = await createDvpTrade(env, tradeInput());

    expect(trade.userA).toBe(address(custodyWalletAddress));
    const rows = await rowsInDb();
    expect(rows[0].counterparty_account_id_a).toBeNull();
    expect(rows[0].counterparty_account_id_b).toBeNull();
  });

  // A `{ counterpartyAccountId }` slot stores the ref and resolves the linked
  // address from the account's details JSONB.
  it("resolves a counterpartyAccountId slot to the linked address and stores the ref", async () => {
    const db = getDb(env);
    await db
      .prepare(
        `INSERT INTO counterparties (id, organization_id, project_id, entity_type, display_name)
         VALUES ('cpty_resolve', ?, ?, 'individual', 'Ada')`
      )
      .bind(TEST_ORG.id, TEST_PROJECT_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO counterparty_accounts
           (id, organization_id, project_id, counterparty_id, account_kind, details, status)
         VALUES ('cpa_resolve', ?, ?, 'cpty_resolve', 'crypto_wallet',
                 '{"network":"solana","address":"${COUNTERPARTY_ADDRESS}"}'::jsonb, 'active')`
      )
      .bind(TEST_ORG.id, TEST_PROJECT_ID)
      .run();

    sendTransaction.mockResolvedValue("sig");
    const trade = await createDvpTrade(env, {
      ...tradeInput(),
      partyA: { counterpartyAccountId: "cpa_resolve" },
      partyB: { address: address("GjupWG8a4BXmduuUQt7vP7QxJ5Kq5YhwKZNkFYp5KPr") },
    });

    expect(trade.userA).toBe(address(COUNTERPARTY_ADDRESS));
    const rows = await rowsInDb();
    expect(rows[0].counterparty_account_id_a).toBe("cpa_resolve");
    expect(rows[0].counterparty_account_id_b).toBeNull();
  });

  // Wrong-kind account (e.g. a bank kind, which the open schema permits) is
  // refused — only crypto_wallet accounts name a Solana party.
  it("refuses a counterpartyAccountId slot of the wrong kind", async () => {
    const db = getDb(env);
    await db
      .prepare(
        `INSERT INTO counterparties (id, organization_id, project_id, entity_type, display_name)
         VALUES ('cpty_bank', ?, ?, 'individual', 'Bo')`
      )
      .bind(TEST_ORG.id, TEST_PROJECT_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO counterparty_accounts
           (id, organization_id, project_id, counterparty_id, account_kind, status)
         VALUES ('cpa_bank', ?, ?, 'cpty_bank', 'bank_account', 'active')`
      )
      .bind(TEST_ORG.id, TEST_PROJECT_ID)
      .run();

    sendTransaction.mockResolvedValue("sig");
    await expect(
      createDvpTrade(env, {
        ...tradeInput(),
        partyA: { counterpartyAccountId: "cpa_bank" },
      })
    ).rejects.toThrow(/crypto_wallet/);
    await expect(rowsInDb()).resolves.toEqual([]);
  });

  // An archived account is invisible to the scoped lookup, so it is refused
  // the same way an unknown one is.
  it("refuses an archived counterparty account", async () => {
    const db = getDb(env);
    await db
      .prepare(
        `INSERT INTO counterparties (id, organization_id, project_id, entity_type, display_name)
         VALUES ('cpty_archived', ?, ?, 'individual', 'Ari')`
      )
      .bind(TEST_ORG.id, TEST_PROJECT_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO counterparty_accounts
           (id, organization_id, project_id, counterparty_id, account_kind, status)
         VALUES ('cpa_archived', ?, ?, 'cpty_archived', 'crypto_wallet', 'archived')`
      )
      .bind(TEST_ORG.id, TEST_PROJECT_ID)
      .run();

    sendTransaction.mockResolvedValue("sig");
    await expect(
      createDvpTrade(env, {
        ...tradeInput(),
        partyA: { counterpartyAccountId: "cpa_archived" },
      })
    ).rejects.toThrow(/counterpartyAccountId/);
    await expect(rowsInDb()).resolves.toEqual([]);
  });

  // Cross-parent defense: an account in another project does not resolve here.
  it("refuses a counterparty account belonging to another project", async () => {
    const db = getDb(env);
    await db
      .prepare(
        `INSERT INTO counterparties (id, organization_id, project_id, entity_type, display_name)
         VALUES ('cpty_other', ?, ?, 'individual', 'Oth')`
      )
      .bind(TEST_ORG.id, TEST_PROJECT_ID_OTHER)
      .run();
    await db
      .prepare(
        `INSERT INTO counterparty_accounts
           (id, organization_id, project_id, counterparty_id, account_kind, details, status)
         VALUES ('cpa_other', ?, ?, 'cpty_other', 'crypto_wallet',
                 '{"network":"solana","address":"${COUNTERPARTY_ADDRESS}"}'::jsonb, 'active')`
      )
      .bind(TEST_ORG.id, TEST_PROJECT_ID_OTHER)
      .run();

    sendTransaction.mockResolvedValue("sig");
    await expect(
      createDvpTrade(env, {
        ...tradeInput(),
        partyA: { counterpartyAccountId: "cpa_other" },
      })
    ).rejects.toThrow(/counterpartyAccountId/);
    await expect(rowsInDb()).resolves.toEqual([]);
  });

  // Unknown walletId — no active custody wallet with that row id in scope.
  it("refuses an unknown walletId", async () => {
    sendTransaction.mockResolvedValue("sig");
    await expect(
      createDvpTrade(env, {
        ...tradeInput(),
        partyA: { walletId: "cwlt_nonexistent" },
      })
    ).rejects.toThrow(/walletId/);
    await expect(rowsInDb()).resolves.toEqual([]);
  });

  // An archived wallet never appears in the active-only wallet list, so it is
  // refused the same way an unknown one is.
  it("refuses an archived wallet", async () => {
    const db = getDb(env);
    const archivedSigner = await generateKeyPairSigner();
    await db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES ('cwlt_archived', ?, 'w_arch', ?, 'archived')`
      )
      .bind(CUSTODY_CONFIG_ID, archivedSigner.address)
      .run();

    sendTransaction.mockResolvedValue("sig");
    await expect(
      createDvpTrade(env, {
        ...tradeInput(),
        partyA: { walletId: "cwlt_archived" },
      })
    ).rejects.toThrow(/walletId/);
    await expect(rowsInDb()).resolves.toEqual([]);
  });

  // An explicit payer signs with that wallet; an omitted payer signs with the
  // settlement wallet.
  it("signs with an explicit payer wallet when one is given", async () => {
    sendTransaction.mockResolvedValue("sig");
    await createDvpTrade(env, {
      ...tradeInput(),
      partyA: { address: address(COUNTERPARTY_ADDRESS) },
      partyB: { address: address("GjupWG8a4BXmduuUQt7vP7QxJ5Kq5YhwKZNkFYp5KPr") },
      payerWalletId: CUSTODY_WALLET_ID,
    });

    expect(createOrgSignerForCustodyWallet).toHaveBeenCalledWith(
      env,
      TEST_ORG.id,
      TEST_PROJECT_ID,
      CUSTODY_WALLET_ID
    );
  });

  it("signs with the settlement wallet when no payer is given", async () => {
    sendTransaction.mockResolvedValue("sig");
    await createDvpTrade(env, tradeInput());

    expect(createOrgSignerForCustodyWallet).toHaveBeenCalledWith(
      env,
      TEST_ORG.id,
      TEST_PROJECT_ID,
      "cwlt_settlement"
    );
  });

  // The reference kind is material: `{address: X}` and `{walletId}`-resolving-to-X
  // hash differently, so the same key reused with the flipped slot 409s.
  it("refuses a key reused when a slot flips from address to walletId-resolving-to-the-same-address", async () => {
    sendTransaction.mockResolvedValue("sig");
    // First request: partyA as the custody wallet, whose address IS
    // custodyWalletAddress. Second request: partyA as a bare address equal to
    // custodyWalletAddress. Same resolved address, different reference kind.
    const inputWallet = { ...tradeInput(), idempotencyKey: "key-flip" };
    await createDvpTrade(env, inputWallet);

    await expect(
      createDvpTrade(env, {
        ...tradeInput(),
        idempotencyKey: "key-flip",
        partyA: { address: address(custodyWalletAddress) },
      })
    ).rejects.toThrow(/different request payload/);
  });

  // A re-pointed counterparty account (same id, new address) between two keyed
  // calls is a different trade: the reference value is unchanged but the
  // resolved address changed, and both are material.
  it("refuses a key reused after the counterparty account is re-pointed to a new address", async () => {
    const db = getDb(env);
    await db
      .prepare(
        `INSERT INTO counterparties (id, organization_id, project_id, entity_type, display_name)
         VALUES ('cpty_repoint', ?, ?, 'individual', 'Ari')`
      )
      .bind(TEST_ORG.id, TEST_PROJECT_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO counterparty_accounts
           (id, organization_id, project_id, counterparty_id, account_kind, details, status)
         VALUES ('cpa_repoint', ?, ?, 'cpty_repoint', 'crypto_wallet',
                 '{"network":"solana","address":"${COUNTERPARTY_ADDRESS}"}'::jsonb, 'active')`
      )
      .bind(TEST_ORG.id, TEST_PROJECT_ID)
      .run();

    sendTransaction.mockResolvedValue("sig");
    const input = {
      ...tradeInput(),
      partyA: { counterpartyAccountId: "cpa_repoint" },
      partyB: { address: address("GjupWG8a4BXmduuUQt7vP7QxJ5Kq5YhwKZNkFYp5KPr") },
      idempotencyKey: "key-repoint",
    } as const;
    await createDvpTrade(env, input);

    // Re-point the account to a different address.
    await db
      .prepare(
        `UPDATE counterparty_accounts
            SET details = '{"network":"solana","address":"EdBvwdvCVfNRsKk6F6g5TthdN3Ci8jQgrxTGpCwAHjux"}'::jsonb
          WHERE id = 'cpa_repoint'`
      )
      .run();

    await expect(createDvpTrade(env, input)).rejects.toThrow(/different request payload/);
  });
});
