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

import { FeePaymentError } from "@sdp/payments/fee-payment";
import { WELL_KNOWN_TOKENS } from "@sdp/types";
import {
  address,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase58Codec,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  pipe,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SolanaError,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signature,
  signatureBytes,
} from "@solana/kit";
import { generateKeyPairSigner } from "@solana/signers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import type { DvpTradeRow } from "@/db/repositories";
import type { AppError } from "@/lib/errors";
import type { SponsorshipFeePayment } from "@/services/sponsorship.service";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";

const createProjectSponsorshipFeePayment = vi.hoisted(() => vi.fn());
const getFeePayer = vi.hoisted(() => vi.fn());
const prepareOwnedSubmission = vi.hoisted(() => vi.fn());
const releaseDefinitelyUnbroadcast = vi.hoisted(() => vi.fn());
const sendTransaction = vi.hoisted(() => vi.fn());
// The mint pre-flight is verified separately against real devnet mints in
// mints.test.ts; here it is stubbed so these tests stay about broadcast
// ordering. The last case below still proves create is wired to it.
const validateDvpMints = vi.hoisted(() => vi.fn());
const inspectDvpMint = vi.hoisted(() => vi.fn());

vi.mock("@/services/sponsorship.service", async () => {
  const actual = await vi.importActual<typeof import("@/services/sponsorship.service")>(
    "@/services/sponsorship.service"
  );
  return { ...actual, createProjectSponsorshipFeePayment };
});
vi.mock("./mints", () => ({ validateDvpMints }));
vi.mock("./inspect-mint", () => ({ inspectDvpMint }));
// The immediate chain read after a send is the reconciler's contract, tested in
// observe-now.test.ts; here it is stubbed so these tests stay about the claim,
// sign and send ordering. Null means "nothing observed yet".
const observeDvpTradeNow = vi.hoisted(() => vi.fn());
vi.mock("./observe-now", () => ({ observeDvpTradeNow }));
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

// Computed once at module load, NOT per call: the fingerprint hashes the
// expiry, so two tradeInput() calls straddling a second boundary would be
// different requests and 409 a replay the test meant to be identical.
const EXPIRY_TIMESTAMP = BigInt(Math.floor(Date.now() / 1000) + 3600);
const TEST_SIGNATURE = signature(
  "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy"
);

/**
 * Configures RPC acceptance with the signature encoded in the submitted bytes.
 *
 * @returns Nothing.
 */
function acceptSend(): void {
  sendTransaction.mockImplementation(async (_rpc: unknown, bytes: Uint8Array) =>
    getSignatureFromTransaction(getTransactionDecoder().decode(bytes))
  );
}

function tradeInput() {
  return {
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT_ID,
    partyA: { walletId: CUSTODY_WALLET_ID },
    partyB: { address: address(COUNTERPARTY_ADDRESS) },
    mintA: address("ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1"),
    tokenProgramA: address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
    mintB: address("AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE"),
    tokenProgramB: address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
    amountA: 1000n,
    amountB: 2000n,
    expiryTimestamp: EXPIRY_TIMESTAMP,
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
    create_signature: string | null;
    create_last_valid_block_height: string | null;
    name_a: string | null;
    name_b: string | null;
  }[]
> {
  const result = await getDb(env)
    .prepare(
      "SELECT id, status, nonce, counterparty_account_id_a, counterparty_account_id_b, create_signature, create_last_valid_block_height, name_a, name_b FROM dvp_trades"
    )
    .all<{
      id: string;
      status: string;
      nonce: string;
      counterparty_account_id_a: string | null;
      counterparty_account_id_b: string | null;
      create_signature: string | null;
      create_last_valid_block_height: string | null;
      name_a: string | null;
      name_b: string | null;
    }>();
  return result.results ?? [];
}

describe("createDvpTrade", () => {
  let custodyWalletAddress: string;
  let sponsor: Awaited<ReturnType<typeof generateKeyPairSigner>>;
  let originalSettlementAuthority: string | undefined;
  let originalByok: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    await seedTestDatabase(env);
    originalByok = env.PRIVY_BYOK_ENABLED;
    env.PRIVY_BYOK_ENABLED = "false";
    validateDvpMints.mockResolvedValue([]);
    // Carried onto the row so later surfaces can show the trade in the units
    // somebody typed, with the token named.
    inspectDvpMint.mockResolvedValue({
      decimals: 6,
      symbol: "ATD",
      name: "Acme Treasury Debt",
    });
    sponsor = await generateKeyPairSigner();
    getFeePayer.mockResolvedValue(sponsor.address);
    prepareOwnedSubmission.mockImplementation(
      async (
        bytes: Uint8Array,
        lifecycle: Parameters<SponsorshipFeePayment["prepareOwnedSubmission"]>[1]
      ) => {
        const transaction = getTransactionDecoder().decode(bytes);
        expect(transaction.signatures[sponsor.address]).toBeNull();
        const signed = await partiallySignTransaction([sponsor.keyPair], transaction);
        const signedTransaction = new Uint8Array(getTransactionEncoder().encode(signed));
        const signature = getSignatureFromTransaction(signed);
        const submission = { signedTransaction, signature, releaseDefinitelyUnbroadcast };
        await lifecycle.persistSigned(submission);
        await lifecycle.markStarted();
        return submission;
      }
    );
    observeDvpTradeNow.mockResolvedValue(null);
    createProjectSponsorshipFeePayment.mockResolvedValue({
      getFeePayer,
      prepareOwnedSubmission,
    });
    acceptSend();
    originalSettlementAuthority = env.DVP_SETTLEMENT_AUTHORITY;
    env.DVP_SETTLEMENT_AUTHORITY = SETTLEMENT_AUTHORITY;

    const db = getDb(env);
    await db
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    await db.execute("UPDATE organizations SET settings = ? WHERE id = ?", [
      JSON.stringify({ providerOverrides: { custody: { local: true } } }),
      TEST_ORG.id,
    ]);
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
        `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES (?, ?, ?, 'local', 'x', 'active')`
      )
      .bind(CUSTODY_CONFIG_ID, TEST_ORG.id, TEST_PROJECT_ID)
      .run();

    const signer = await generateKeyPairSigner();
    custodyWalletAddress = signer.address;

    await db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, ?, 'w1', ?, 'active')`
      )
      .bind(CUSTODY_WALLET_ID, CUSTODY_CONFIG_ID, custodyWalletAddress)
      .run();
    await db.execute(
      `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
       VALUES ('cwlt_settlement', ?, 'provider_settlement', ?, 'active')`,
      [CUSTODY_CONFIG_ID, SETTLEMENT_AUTHORITY]
    );
    await db.execute(
      `INSERT INTO dvp_settlement_wallets (project_id, organization_id, custody_wallet_id)
       VALUES (?, ?, 'cwlt_settlement')`,
      [TEST_PROJECT_ID, TEST_ORG.id]
    );
  });

  afterEach(() => {
    env.DVP_SETTLEMENT_AUTHORITY = originalSettlementAuthority;
    env.PRIVY_BYOK_ENABLED = originalByok;
  });

  async function useConnectionAuthority() {
    const db = getDb(env);
    await db.execute(
      `INSERT INTO provider_credentials
       (id, organization_id, project_id, provider, label, scope, source, storage_backend, status, created_by)
       VALUES ('pcred_dvp', ?, ?, 'privy', 'DvP authority', 'project', 'runtime', 'runtime_env', 'active', ?)`,
      [TEST_ORG.id, TEST_PROJECT_ID, TEST_USER.id]
    );
    await db.execute(
      `INSERT INTO custody_connections
       (id, organization_id, project_id, provider, scope, provider_credential_id,
        provider_credential_scope_key, status, provider_account_fingerprint, created_by)
       VALUES ('cconn_dvp', ?, ?, 'privy', 'project', 'pcred_dvp', ?, 'pending', 'sha256:dvp', ?)`,
      [TEST_ORG.id, TEST_PROJECT_ID, TEST_PROJECT_ID, TEST_USER.id]
    );
    await db.execute(`UPDATE custody_wallets SET custody_config_id = NULL,
      custody_connection_id = 'cconn_dvp' WHERE id = 'cwlt_settlement'`);
    await db.execute(`UPDATE custody_connections SET default_custody_wallet_id = 'cwlt_settlement',
      status = 'active', last_check_status = 'success', last_check_at = sdp_iso_now(),
      activated_at = sdp_iso_now() WHERE id = 'cconn_dvp'`);
  }

  it("refuses a paused authority before creating a trade, replacement or sponsor request", async () => {
    await useConnectionAuthority();

    await expect(createDvpTrade(env, tradeInput())).rejects.toMatchObject({
      statusCode: 403,
      details: { reason: "runtime_execution_paused" },
    });
    expect(await rowsInDb()).toEqual([]);
    expect(createProjectSponsorshipFeePayment).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(
      await getDb(env).queryMany("SELECT custody_wallet_id FROM dvp_settlement_wallets")
    ).toEqual([{ custody_wallet_id: "cwlt_settlement" }]);
    expect(await getDb(env).queryMany("SELECT id FROM custody_wallets")).toHaveLength(2);
  });

  it.each(["connection", "credential", "entitlement"] as const)(
    "refuses an authority with unavailable %s before recording or sponsoring a trade",
    async (unavailable) => {
      await useConnectionAuthority();
      env.PRIVY_BYOK_ENABLED = "true";
      const db = getDb(env);
      if (unavailable === "connection") {
        await db.execute(`UPDATE custody_connections SET status = 'deactivated',
          deactivated_at = sdp_iso_now() WHERE id = 'cconn_dvp'`);
      } else if (unavailable === "credential") {
        await db.execute(
          "UPDATE provider_credentials SET status = 'retired' WHERE id = 'pcred_dvp'"
        );
      } else {
        await db.execute("UPDATE organizations SET settings = ? WHERE id = ?", [
          JSON.stringify({ providerOverrides: { custody: { local: true, privy: false } } }),
          TEST_ORG.id,
        ]);
      }

      await expect(createDvpTrade(env, tradeInput())).rejects.toMatchObject({
        statusCode: unavailable === "entitlement" ? 403 : 409,
      });
      expect(await rowsInDb()).toEqual([]);
      expect(createProjectSponsorshipFeePayment).not.toHaveBeenCalled();
      expect(await db.queryMany("SELECT custody_wallet_id FROM dvp_settlement_wallets")).toEqual([
        { custody_wallet_id: "cwlt_settlement" },
      ]);
      expect(await db.queryMany("SELECT id FROM custody_wallets")).toHaveLength(2);
    }
  );

  it("creates with an admitted nondefault Connection authority", async () => {
    await useConnectionAuthority();
    env.PRIVY_BYOK_ENABLED = "true";
    await getDb(env).execute(
      `INSERT INTO custody_scope_defaults
       (id, organization_id, project_id, default_custody_config_id)
       VALUES ('csd_dvp', ?, ?, ?)`,
      [TEST_ORG.id, TEST_PROJECT_ID, CUSTODY_CONFIG_ID]
    );

    const trade = await createDvpTrade(env, tradeInput());

    expect(trade.settlementAuthority).toBe(SETTLEMENT_AUTHORITY);
    expect(sendTransaction).toHaveBeenCalledOnce();
    expect(createProjectSponsorshipFeePayment).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ actor: { type: "wallet", id: "cwlt_settlement" } })
    );
  });

  it("replays the recorded create after BYOK is paused without sponsoring again", async () => {
    await useConnectionAuthority();
    env.PRIVY_BYOK_ENABLED = "true";
    const input = { ...tradeInput(), idempotencyKey: "byok-replay" };
    const original = await createDvpTrade(env, input);
    env.PRIVY_BYOK_ENABLED = "false";

    expect((await createDvpTrade(env, input)).id).toBe(original.id);
    await expect(createDvpTrade(env, { ...input, amountA: 2000n })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(await rowsInDb()).toHaveLength(1);
    expect(sendTransaction).toHaveBeenCalledOnce();
    expect(createProjectSponsorshipFeePayment).toHaveBeenCalledOnce();
  });

  it("admits a new attempt after a failed create instead of replaying through a paused authority", async () => {
    await useConnectionAuthority();
    env.PRIVY_BYOK_ENABLED = "true";
    const input = { ...tradeInput(), idempotencyKey: "byok-failed-retry" };
    createProjectSponsorshipFeePayment.mockRejectedValueOnce(new Error("Sponsor unavailable"));
    await expect(createDvpTrade(env, input)).rejects.toThrow("Sponsor unavailable");
    env.PRIVY_BYOK_ENABLED = "false";

    await expect(createDvpTrade(env, input)).rejects.toMatchObject({
      statusCode: 403,
      details: { reason: "runtime_execution_paused" },
    });
    expect(await rowsInDb()).toMatchObject([{ status: "create_failed" }]);
    expect(createProjectSponsorshipFeePayment).toHaveBeenCalledOnce();
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("has the trade durably recorded at `creating` before the bytes go out", async () => {
    let rowsAtSendTime: Awaited<ReturnType<typeof rowsInDb>> = [];
    sendTransaction.mockImplementation(async (_rpc: unknown, bytes: Uint8Array) => {
      rowsAtSendTime = await rowsInDb();
      return getSignatureFromTransaction(getTransactionDecoder().decode(bytes));
    });

    const trade = await createDvpTrade(env, tradeInput());

    expect(sendTransaction).toHaveBeenCalledTimes(1);
    expect(rowsAtSendTime).toHaveLength(1);
    expect(rowsAtSendTime[0].status).toBe("creating");
    expect(rowsAtSendTime[0].id).toBe(trade.id);
    // The nonce is the seed that makes the row recoverable at all.
    expect(rowsAtSendTime[0].nonce).toBe(trade.nonce);
  });

  it("stores token names from mint metadata and the well-known registry fallback", async () => {
    inspectDvpMint
      .mockResolvedValueOnce({ decimals: 6, symbol: "ATD", name: "Circle Reserve Fund" })
      .mockResolvedValueOnce({ decimals: 6, symbol: null, name: null });
    const input = {
      ...tradeInput(),
      mintB: address(WELL_KNOWN_TOKENS.USDG.mints["mainnet-beta"].address),
    };

    const trade = await createDvpTrade(env, input);
    const rows = await rowsInDb();

    expect(trade.nameA).toBe("Circle Reserve Fund");
    expect(trade.nameB).toBe("Global Dollar");
    expect(rows).toMatchObject([{ name_a: "Circle Reserve Fund", name_b: "Global Dollar" }]);
  });

  it("leaves the trade creating until chain observation confirms it", async () => {
    acceptSend();

    const trade = await createDvpTrade(env, tradeInput());

    expect(trade.status).toBe("creating");
    expect(trade.createSignature).toBeTruthy();
    expect(observeDvpTradeNow).toHaveBeenCalledOnce();
    await expect(rowsInDb()).resolves.toMatchObject([{ status: "creating" }]);
  });

  // RPC acceptance is not confirmation. Only a chain read may say `created`,
  // and when the immediate read already sees the account the caller gets that
  // row rather than a stale claim.
  it("returns the observed row when the immediate chain read sees the trade", async () => {
    acceptSend();
    observeDvpTradeNow.mockImplementationOnce(async (_env: unknown, claimed: DvpTradeRow) => ({
      ...claimed,
      status: "created" as const,
    }));

    const trade = await createDvpTrade(env, tradeInput());

    expect(trade.status).toBe("created");
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

    await expect(createDvpTrade(env, tradeInput())).rejects.toMatchObject({
      code: "TRANSACTION_FAILED",
    } satisfies Partial<AppError>);

    const rows = await rowsInDb();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("create_failed");
    expect(releaseDefinitelyUnbroadcast).toHaveBeenCalledTimes(1);
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
    expect(rows[0].create_signature).not.toBeNull();
    expect(rows[0].create_last_valid_block_height).toBe("100");
    expect(releaseDefinitelyUnbroadcast).not.toHaveBeenCalled();
  });

  // The pre-flight has to run BEFORE anything is signed or written. A mint the
  // program refuses would otherwise cost a signature and leave a create_failed
  // row behind for a request that could have been a plain 400.
  it("refuses a mint the program would reject, before signing or writing", async () => {
    validateDvpMints.mockResolvedValue([
      "mintA carries the ScaledUiAmountConfig extension, which DvP settlement refuses",
    ]);

    await expect(createDvpTrade(env, tradeInput())).rejects.toThrow(/ScaledUiAmountConfig/);

    expect(createProjectSponsorshipFeePayment).not.toHaveBeenCalled();
    expect(prepareOwnedSubmission).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
    await expect(rowsInDb()).resolves.toEqual([]);
  });

  // A retry after an ambiguous broadcast must return the ORIGINAL trade. Create
  // draws a fresh nonce every time, so without this the retry lands at a
  // different address and the first trade sits on chain with a published escrow
  // nobody is watching.
  it("returns the original trade when a keyed request is retried", async () => {
    acceptSend();
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
      acceptSend();

      const retried = await createDvpTrade(env, { ...tradeInput(), idempotencyKey: "key-retry" });

      expect(retried.status).toBe("creating");
    });

    it("keeps the failed attempt on the record rather than deleting it", async () => {
      await failOnceWith("key-retry");
      acceptSend();

      await createDvpTrade(env, { ...tradeInput(), idempotencyKey: "key-retry" });

      const rows = await rowsInDb();
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.status).sort()).toEqual(["create_failed", "creating"]);
    });

    // Freed on the dead row only. Leaving it there would let a second retry
    // replay the corpse again.
    it("frees the key from the failed row so only the live trade answers to it", async () => {
      await failOnceWith("key-retry");
      acceptSend();
      const live = await createDvpTrade(env, { ...tradeInput(), idempotencyKey: "key-retry" });

      const replayed = await createDvpTrade(env, { ...tradeInput(), idempotencyKey: "key-retry" });

      expect(replayed.id).toBe(live.id);
      await expect(rowsInDb()).resolves.toHaveLength(2);
    });
  });

  // An AMBIGUOUS failure is the opposite case: the transaction may still land,
  // so its key must keep answering or the retry would create a second trade at
  // a second address while the first sits on chain.
  // An ambiguous send is one the submission helper neither classifies as a
  // preflight rejection nor retries as transient: the transaction may be in
  // flight, so the claim keeps its signature and stays `creating` for the chain
  // reader. (A transient failure such as a hung socket is retried by the
  // helper itself; that schedule is covered in sponsorship-submission's tests.)
  it("does not free the key of a trade still stuck at creating", async () => {
    sendTransaction.mockRejectedValueOnce(new Error("rpc returned an unreadable response"));
    await expect(
      createDvpTrade(env, { ...tradeInput(), idempotencyKey: "key-ambiguous" })
    ).rejects.toThrow("rpc returned an unreadable response");

    acceptSend();
    const retried = await createDvpTrade(env, {
      ...tradeInput(),
      idempotencyKey: "key-ambiguous",
    });

    expect(retried.status).toBe("creating");
    await expect(rowsInDb()).resolves.toHaveLength(1);
  });

  // Two overlapping retries both miss the lookup and both reach the insert. The
  // unique index rejects one, and without recovery that retry gets a 500 —
  // exactly the case the key exists to make safe.
  it("replays rather than failing when two keyed requests race", async () => {
    acceptSend();
    const input = { ...tradeInput(), idempotencyKey: "key-race" };

    const [first, second] = await Promise.all([
      createDvpTrade(env, input),
      createDvpTrade(env, input),
    ]);

    expect(second.id).toBe(first.id);
    await expect(rowsInDb()).resolves.toHaveLength(1);
    // The loser must not broadcast a second transaction for the same trade.
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    expect(createProjectSponsorshipFeePayment).toHaveBeenCalledTimes(1);
    expect(getFeePayer).toHaveBeenCalledTimes(1);
    expect(prepareOwnedSubmission).toHaveBeenCalledTimes(1);
  });

  it("creates separate trades for different keys", async () => {
    acceptSend();

    const first = await createDvpTrade(env, { ...tradeInput(), idempotencyKey: "key-a" });
    const second = await createDvpTrade(env, { ...tradeInput(), idempotencyKey: "key-b" });

    expect(second.id).not.toBe(first.id);
    expect(sendTransaction).toHaveBeenCalledTimes(2);
  });

  // Without a key there is nothing to replay against, so each call is a new
  // trade — which is exactly why the key matters on a retry.
  it("creates a new trade every time when no key is sent", async () => {
    acceptSend();

    const first = await createDvpTrade(env, tradeInput());
    const second = await createDvpTrade(env, tradeInput());

    expect(second.id).not.toBe(first.id);
  });

  it("resolves sponsorship after term validation", async () => {
    await expect(
      createDvpTrade(env, {
        ...tradeInput(),
        partyB: { address: address(SETTLEMENT_AUTHORITY) },
      })
    ).rejects.toThrow(/settlementAuthority must not be/);

    expect(createProjectSponsorshipFeePayment).not.toHaveBeenCalled();
    expect(prepareOwnedSubmission).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
    await expect(rowsInDb()).resolves.toEqual([]);
  });

  // A `{ walletId }` slot resolves to the wallet's address and stores NULL
  // attribution — fundability re-derives later, never from a stored column.
  it("resolves a walletId slot to the wallet's address and stores null attribution", async () => {
    acceptSend();

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

    acceptSend();
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

    acceptSend();
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

    acceptSend();
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

    acceptSend();
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
    acceptSend();
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

    acceptSend();
    await expect(
      createDvpTrade(env, {
        ...tradeInput(),
        partyA: { walletId: "cwlt_archived" },
      })
    ).rejects.toThrow(/walletId/);
    await expect(rowsInDb()).resolves.toEqual([]);
  });

  it("uses the sponsor as fee payer and instruction payer in one signature slot", async () => {
    acceptSend();
    const trade = await createDvpTrade(env, tradeInput());

    const [, bytes] = sendTransaction.mock.calls[0];
    const transaction = getTransactionDecoder().decode(bytes);
    const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    expect(Object.keys(transaction.signatures)).toEqual([sponsor.address]);
    expect(message.staticAccounts[0]).toBe(sponsor.address);
    expect(message).toMatchObject({
      version: 0,
      instructions: [{ accountIndices: expect.arrayContaining([0]) }],
    });
    expect(trade.createSignature).toBe(getSignatureFromTransaction(transaction));
    expect(createProjectSponsorshipFeePayment).toHaveBeenCalledWith(env, {
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      actor: { type: "wallet", id: "cwlt_settlement" },
    });
  });

  it("refuses sponsor bytes over a different message", async () => {
    prepareOwnedSubmission.mockImplementation(async (_bytes: Uint8Array, lifecycle) => {
      const foreign = pipe(
        createTransactionMessage({ version: 0 }),
        (message) => setTransactionMessageFeePayer(sponsor.address, message),
        (message) =>
          setTransactionMessageLifetimeUsingBlockhash(
            {
              blockhash: getBase58Codec().decode(new Uint8Array(32).fill(9)) as Blockhash,
              lastValidBlockHeight: 100n,
            },
            message
          ),
        (message) =>
          appendTransactionMessageInstructions(
            [{ programAddress: address("11111111111111111111111111111111") }],
            message
          ),
        compileTransaction
      );
      const signed = await partiallySignTransaction([sponsor.keyPair], foreign);
      const signedTransaction = new Uint8Array(getTransactionEncoder().encode(signed));
      const submission = {
        signedTransaction,
        signature: getSignatureFromTransaction(signed),
        releaseDefinitelyUnbroadcast,
      };
      await lifecycle.persistSigned(submission);
      return submission;
    });

    await expect(createDvpTrade(env, tradeInput())).rejects.toThrow(/different message/);
    await expect(rowsInDb()).resolves.toMatchObject([{ status: "create_failed" }]);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("refuses bytes without the sponsor signature", async () => {
    prepareOwnedSubmission.mockImplementation(async (bytes: Uint8Array, lifecycle) => {
      const submission = {
        signedTransaction: bytes,
        signature: TEST_SIGNATURE,
        releaseDefinitelyUnbroadcast,
      };
      await lifecycle.persistSigned(submission);
      return submission;
    });

    await expect(createDvpTrade(env, tradeInput())).rejects.toThrow(/missing the sponsor/);
    await expect(rowsInDb()).resolves.toMatchObject([{ status: "create_failed" }]);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  // A filled slot is not a signature. Kora is trusted to sign, not to be
  // infallible: bytes that fail Ed25519 against the sponsor's key must fail the
  // claim here, not be persisted in flight for the RPC to reject later.
  it("refuses a sponsor signature that does not verify", async () => {
    prepareOwnedSubmission.mockImplementation(async (bytes: Uint8Array, lifecycle) => {
      const transaction = getTransactionDecoder().decode(bytes);
      const forged = {
        ...transaction,
        signatures: {
          ...transaction.signatures,
          [sponsor.address]: signatureBytes(new Uint8Array(64).fill(9)),
        },
      };
      const submission = {
        signedTransaction: new Uint8Array(getTransactionEncoder().encode(forged)),
        signature: TEST_SIGNATURE,
        releaseDefinitelyUnbroadcast,
      };
      await lifecycle.persistSigned(submission);
      return submission;
    });

    await expect(createDvpTrade(env, tradeInput())).rejects.toThrow(/invalid sponsor/);
    await expect(rowsInDb()).resolves.toMatchObject([{ status: "create_failed" }]);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("fails the claim when Kora denies and frees the key on replay", async () => {
    const denial = new FeePaymentError("Kora rate limit", "RATE_LIMITED");
    prepareOwnedSubmission.mockRejectedValueOnce(denial);

    const input = { ...tradeInput(), idempotencyKey: "key-kora-denial" };
    await expect(createDvpTrade(env, input)).rejects.toBe(denial);
    await expect(rowsInDb()).resolves.toMatchObject([{ status: "create_failed" }]);

    const retried = await createDvpTrade(env, input);
    expect(retried.status).toBe("creating");
    await expect(rowsInDb()).resolves.toHaveLength(2);
  });
});
