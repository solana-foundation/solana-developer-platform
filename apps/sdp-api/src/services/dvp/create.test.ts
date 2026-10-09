import assert from "node:assert/strict";
import { FeePaymentError } from "@sdp/payments/fee-payment";
import * as solanaRpc from "@sdp/rpc/solana";
import { WELL_KNOWN_TOKENS } from "@sdp/types";
import {
  address,
  type Blockhash,
  getBase58Codec,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SolanaError,
} from "@solana/kit";
import { generateKeyPairSigner } from "@solana/signers";
import { Context } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db";
import type { DvpTradeRow } from "@/db/repositories";
import type { AppError } from "@/lib/errors";
import * as custodyProvisioning from "@/services/custody/provisioning";
import { custodyProviderNotInReleaseChannel } from "@/services/provider-availability.service";
import type { SponsorshipFeePayment } from "@/services/sponsorship.service";
import * as sponsorshipService from "@/services/sponsorship.service";
import { SponsorMessageMismatchError } from "@/services/sponsorship-integrity";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { testClerkContext } from "@/test/helpers/clerk-context";
import {
  activateTestCustodyConnection,
  insertTestCustodyConnection,
  insertTestStoredProviderCredential,
  writeTestPrivyCredentialSecret,
} from "@/test/helpers/custody-connections";
import { custodyReleaseChannel } from "@/test/helpers/custody-release-channel";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";
import type { Env } from "@/types/env";
import * as mintInspector from "./inspect-mint";
import * as mints from "./mints";
import * as observation from "./observe-now";

vi.mock("@sdp/types/release-channels", async (importOriginal) => {
  const { mockCustodyReleaseChannels } = await import("@/test/helpers/custody-release-channel");
  return mockCustodyReleaseChannels(
    await importOriginal<typeof import("@sdp/types/release-channels")>()
  );
});

const auditContext = new Context<{
  Bindings: Env;
}>(new Request("http://localhost/dvp"), { env });

const createProjectSponsorshipFeePayment = vi.fn();

const getFeePayer = vi.fn();

const prepareOwnedSubmission = vi.fn();

const releaseDefinitelyUnbroadcast = vi.fn();

const sendTransaction = vi.fn();

const validateDvpMints = vi.fn();

const inspectDvpMint = vi.fn();

const observeDvpTradeNow = vi.fn();

const { createDvpTrade } = await import("./create");

const TEST_PROJECT_ID = "prj_dvp_create_test";

const CUSTODY_CONFIG_ID = "cust_dvp_create_test";

const CUSTODY_WALLET_ID = "cwlt_dvp_create_test";

const SETTLEMENT_AUTHORITY = "9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY";

const COUNTERPARTY_ADDRESS = "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg";

const CONNECTION_APP_SECRET = "dvp-connection-secret";

const EXPIRY_TIMESTAMP = BigInt(Math.floor(Date.now() / 1000) + 3600);

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
    userASettlementDestination: null,
    userBSettlementDestination: null,
    idempotencyKey: null,
  };
}

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
  return result.results;
}

describe("createDvpTrade", () => {
  let custodyWalletAddress: string;
  let sponsor: Awaited<ReturnType<typeof generateKeyPairSigner>>;
  let originalSettlementAuthority: string | undefined;
  let originalEncryptionKey: string | undefined;
  beforeEach(async () => {
    custodyReleaseChannel.outOfChannelMode = null;
    vi.clearAllMocks();
    vi.spyOn(sponsorshipService, "createProjectSponsorshipFeePayment").mockImplementation(
      createProjectSponsorshipFeePayment
    );
    vi.spyOn(mints, "validateDvpMints").mockImplementation(validateDvpMints);
    vi.spyOn(mintInspector, "inspectDvpMint").mockImplementation(inspectDvpMint);
    vi.spyOn(observation, "observeDvpTradeNow").mockImplementation(observeDvpTradeNow);
    vi.spyOn(solanaRpc, "getRecentBlockhash").mockResolvedValue({
      blockhash: getBase58Codec().decode(new Uint8Array(32).fill(7)) as Blockhash,
      lastValidBlockHeight: 100n,
    });
    vi.spyOn(solanaRpc, "sendTransaction").mockImplementation(sendTransaction);
    await seedTestDatabase(env);
    originalEncryptionKey = env.CUSTODY_ENCRYPTION_KEY;
    validateDvpMints.mockResolvedValue([]);
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
    await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [],
      ids: { sandbox: TEST_PROJECT_ID, production: `${TEST_PROJECT_ID}_production` },
    });
    await db
      .prepare(`INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES (?, ?, ?, 'local', 'x', 'active')`)
      .bind(CUSTODY_CONFIG_ID, TEST_ORG.id, TEST_PROJECT_ID)
      .run();
    const signer = await generateKeyPairSigner();
    custodyWalletAddress = signer.address;
    await db
      .prepare(`INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, ?, 'w1', ?, 'active')`)
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
    vi.restoreAllMocks();
    env.DVP_SETTLEMENT_AUTHORITY = originalSettlementAuthority;
    env.CUSTODY_ENCRYPTION_KEY = originalEncryptionKey;
  });
  async function seedConnectionAuthority() {
    env.CUSTODY_ENCRYPTION_KEY = Buffer.alloc(32, 23).toString("base64");
    const db = getDb(env);
    await insertTestStoredProviderCredential(db, {
      id: "pcred_dvp",
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      provider: "privy",
      label: "DvP authority",
      stored: await writeTestPrivyCredentialSecret(env, {
        organizationId: TEST_ORG.id,
        credentialId: "pcred_dvp",
        appId: "dvp-connection-app",
        appSecret: CONNECTION_APP_SECRET,
      }),
      displayMetadata: {},
      status: "active",
      credentialVersion: 1,
      rotatedFromProviderCredentialId: null,
      lastValidatedAt: null,
      deactivatedAt: null,
      createdBy: TEST_USER.id,
    });
    await insertTestCustodyConnection(db, {
      id: "cconn_dvp",
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      provider: "privy",
      credential: { id: "pcred_dvp", projectId: TEST_PROJECT_ID },
      status: "pending",
      setupMetadata: {},
      providerAccountFingerprint: "sha256:dvp",
      lastCheckStatus: null,
      lastCheckAt: null,
      lastCheckFailureCode: null,
      activatedAt: null,
      deactivatedAt: null,
      createdBy: TEST_USER.id,
      createdAt: new Date().toISOString(),
    });
    await db.execute(`UPDATE custody_wallets SET custody_config_id = NULL,
      custody_connection_id = 'cconn_dvp' WHERE id = 'cwlt_settlement'`);
    await activateTestCustodyConnection(db, {
      connectionId: "cconn_dvp",
      custodyWalletId: "cwlt_settlement",
      providerAccountFingerprint: "sha256:dvp",
    });
  }
  function byokChannelRefusal() {
    return {
      code: "FORBIDDEN",
      statusCode: 403,
      message: custodyProviderNotInReleaseChannel("privy", "byok").message,
      details: { reason: "custody_provider_not_in_release_channel" },
    };
  }
  it("keeps the BYOK wallet creation audit when the later trade creation fails", async () => {
    const provider = vi.spyOn(custodyProvisioning, "provisionPrivyWallet").mockResolvedValueOnce({
      walletId: "new_dvp_authority",
      address: SETTLEMENT_AUTHORITY,
    });
    auditContext.set("clerk", await testClerkContext(env));
    auditContext.set("requestId", "dvp-create-audit-request");
    await clearKVStores(env);
    try {
      await seedConnectionAuthority();
      const db = getDb(env);
      await db.execute("UPDATE organizations SET tier = 'enterprise' WHERE id = ?", [TEST_ORG.id]);
      await db.execute("DELETE FROM dvp_settlement_wallets WHERE project_id = ?", [
        TEST_PROJECT_ID,
      ]);
      createProjectSponsorshipFeePayment.mockRejectedValueOnce(new Error("Sponsor unavailable"));
      await expect(createDvpTrade(env, auditContext, tradeInput())).rejects.toThrow(
        "Sponsor unavailable"
      );
      expect(provider).toHaveBeenCalledOnce();
      const audit = await db.queryOne<{
        user_id: string;
        request_id: string;
        resource_id: string;
        metadata: string;
      }>(
        "SELECT user_id, request_id, resource_id, metadata FROM audit_logs WHERE resource_type = 'custody_wallet' AND action = 'create'"
      );
      assert(audit, "Expected wallet creation audit");
      expect(audit).toMatchObject({
        user_id: TEST_USER.id,
        request_id: "dvp-create-audit-request",
      });
      const metadata = z
        .object({
          result: z.string(),
          creationReason: z.string(),
          walletId: z.string(),
        })
        .parse(JSON.parse(audit.metadata));
      expect(metadata).toMatchObject({
        result: "created",
        creationReason: "dvp_settlement_authority",
        walletId: "privy_new_dvp_authority",
      });
      expect(
        await db.queryOne("SELECT id FROM custody_wallets WHERE id = ?", [audit.resource_id])
      ).toEqual({ id: audit.resource_id });
      expect(JSON.stringify(audit)).not.toContain(CONNECTION_APP_SECRET);
    } finally {
      provider.mockRestore();
      await clearKVStores(env);
    }
  });
  it("refuses an out-of-channel authority before creating a trade, replacement or sponsor request", async () => {
    await seedConnectionAuthority();
    custodyReleaseChannel.outOfChannelMode = "byok";
    await expect(createDvpTrade(env, auditContext, tradeInput())).rejects.toMatchObject(
      byokChannelRefusal()
    );
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
      await seedConnectionAuthority();
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
      await expect(createDvpTrade(env, auditContext, tradeInput())).rejects.toMatchObject({
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
  it("creates with an admitted Connection authority", async () => {
    await seedConnectionAuthority();
    const trade = await createDvpTrade(env, auditContext, tradeInput());
    expect(trade.settlementAuthority).toBe(SETTLEMENT_AUTHORITY);
    expect(sendTransaction).toHaveBeenCalledOnce();
    expect(createProjectSponsorshipFeePayment).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ actor: { type: "wallet", id: "cwlt_settlement" } })
    );
  });
  it("replays the recorded create after BYOK leaves the release channel without sponsoring again", async () => {
    await seedConnectionAuthority();
    const input = { ...tradeInput(), idempotencyKey: "byok-replay" };
    const original = await createDvpTrade(env, auditContext, input);
    custodyReleaseChannel.outOfChannelMode = "byok";
    expect((await createDvpTrade(env, auditContext, input)).id).toBe(original.id);
    await expect(
      createDvpTrade(env, auditContext, { ...input, amountA: 2000n })
    ).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(await rowsInDb()).toHaveLength(1);
    expect(sendTransaction).toHaveBeenCalledOnce();
    expect(createProjectSponsorshipFeePayment).toHaveBeenCalledOnce();
  });
  it("admits a new attempt after a failed create instead of replaying through an out-of-channel authority", async () => {
    await seedConnectionAuthority();
    const input = { ...tradeInput(), idempotencyKey: "byok-failed-retry" };
    createProjectSponsorshipFeePayment.mockRejectedValueOnce(new Error("Sponsor unavailable"));
    await expect(createDvpTrade(env, auditContext, input)).rejects.toThrow("Sponsor unavailable");
    custodyReleaseChannel.outOfChannelMode = "byok";
    await expect(createDvpTrade(env, auditContext, input)).rejects.toMatchObject(
      byokChannelRefusal()
    );
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
    const trade = await createDvpTrade(env, auditContext, tradeInput());
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    expect(rowsAtSendTime).toHaveLength(1);
    expect(rowsAtSendTime[0].status).toBe("creating");
    expect(rowsAtSendTime[0].id).toBe(trade.id);
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
    const trade = await createDvpTrade(env, auditContext, input);
    const rows = await rowsInDb();
    expect(trade.nameA).toBe("Circle Reserve Fund");
    expect(trade.nameB).toBe("Global Dollar");
    expect(rows).toMatchObject([{ name_a: "Circle Reserve Fund", name_b: "Global Dollar" }]);
  });
  it("leaves the trade creating until chain observation confirms it", async () => {
    acceptSend();
    const trade = await createDvpTrade(env, auditContext, tradeInput());
    expect(trade.status).toBe("creating");
    expect(trade.createSignature).toBeTruthy();
    expect(observeDvpTradeNow).toHaveBeenCalledOnce();
    await expect(rowsInDb()).resolves.toMatchObject([{ status: "creating" }]);
  });
  it("returns the observed row when the immediate chain read sees the trade", async () => {
    acceptSend();
    observeDvpTradeNow.mockImplementationOnce(async (_env: unknown, claimed: DvpTradeRow) => ({
      ...claimed,
      status: "created" as const,
    }));
    const trade = await createDvpTrade(env, auditContext, tradeInput());
    expect(trade.status).toBe("created");
  });
  it("marks the trade create_failed when the RPC rejects it in preflight", async () => {
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
    await expect(createDvpTrade(env, auditContext, tradeInput())).rejects.toMatchObject({
      code: "TRANSACTION_FAILED",
    } satisfies Partial<AppError>);
    const rows = await rowsInDb();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("create_failed");
    expect(releaseDefinitelyUnbroadcast).toHaveBeenCalledTimes(1);
  });
  it("leaves an ambiguously failed send at creating rather than guessing", async () => {
    sendTransaction.mockRejectedValue(new Error("socket hang up"));
    await expect(createDvpTrade(env, auditContext, tradeInput())).rejects.toThrow("socket hang up");
    const rows = await rowsInDb();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("creating");
    expect(rows[0].create_signature).not.toBeNull();
    expect(rows[0].create_last_valid_block_height).toBe("100");
    expect(releaseDefinitelyUnbroadcast).not.toHaveBeenCalled();
  });
  it("refuses a mint the program would reject, before signing or writing", async () => {
    validateDvpMints.mockResolvedValue([
      "mintA carries the ScaledUiAmountConfig extension, which DvP settlement refuses",
    ]);
    await expect(createDvpTrade(env, auditContext, tradeInput())).rejects.toThrow(
      /ScaledUiAmountConfig/
    );
    expect(createProjectSponsorshipFeePayment).not.toHaveBeenCalled();
    expect(prepareOwnedSubmission).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
    await expect(rowsInDb()).resolves.toEqual([]);
  });
  it("returns the original trade when a keyed request is retried", async () => {
    acceptSend();
    const input = { ...tradeInput(), idempotencyKey: "key-1" };
    const first = await createDvpTrade(env, auditContext, input);
    const retried = await createDvpTrade(env, auditContext, input);
    expect(retried.id).toBe(first.id);
    expect(retried.swapDvp).toBe(first.swapDvp);
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    await expect(rowsInDb()).resolves.toHaveLength(1);
  });
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
        createDvpTrade(env, auditContext, { ...tradeInput(), idempotencyKey: key })
      ).rejects.toThrow();
    }
    it("lets the same key create the trade on a retry", async () => {
      await failOnceWith("key-retry");
      acceptSend();
      const retried = await createDvpTrade(env, auditContext, {
        ...tradeInput(),
        idempotencyKey: "key-retry",
      });
      expect(retried.status).toBe("creating");
    });
    it("keeps the failed attempt on the record rather than deleting it", async () => {
      await failOnceWith("key-retry");
      acceptSend();
      await createDvpTrade(env, auditContext, { ...tradeInput(), idempotencyKey: "key-retry" });
      const rows = await rowsInDb();
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.status).sort()).toEqual(["create_failed", "creating"]);
    });
    it("frees the key from the failed row so only the live trade answers to it", async () => {
      await failOnceWith("key-retry");
      acceptSend();
      const live = await createDvpTrade(env, auditContext, {
        ...tradeInput(),
        idempotencyKey: "key-retry",
      });
      const replayed = await createDvpTrade(env, auditContext, {
        ...tradeInput(),
        idempotencyKey: "key-retry",
      });
      expect(replayed.id).toBe(live.id);
      await expect(rowsInDb()).resolves.toHaveLength(2);
    });
  });
  it("does not free the key of a trade still stuck at creating", async () => {
    sendTransaction.mockRejectedValueOnce(new Error("rpc returned an unreadable response"));
    await expect(
      createDvpTrade(env, auditContext, { ...tradeInput(), idempotencyKey: "key-ambiguous" })
    ).rejects.toThrow("rpc returned an unreadable response");
    acceptSend();
    const retried = await createDvpTrade(env, auditContext, {
      ...tradeInput(),
      idempotencyKey: "key-ambiguous",
    });
    expect(retried.status).toBe("creating");
    await expect(rowsInDb()).resolves.toHaveLength(1);
  });
  it("replays rather than failing when two keyed requests race", async () => {
    acceptSend();
    const input = { ...tradeInput(), idempotencyKey: "key-race" };
    const [first, second] = await Promise.all([
      createDvpTrade(env, auditContext, input),
      createDvpTrade(env, auditContext, input),
    ]);
    expect(second.id).toBe(first.id);
    await expect(rowsInDb()).resolves.toHaveLength(1);
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    expect(createProjectSponsorshipFeePayment).toHaveBeenCalledTimes(1);
    expect(getFeePayer).toHaveBeenCalledTimes(1);
    expect(prepareOwnedSubmission).toHaveBeenCalledTimes(1);
  });
  it("creates separate trades for different keys", async () => {
    acceptSend();
    const first = await createDvpTrade(env, auditContext, {
      ...tradeInput(),
      idempotencyKey: "key-a",
    });
    const second = await createDvpTrade(env, auditContext, {
      ...tradeInput(),
      idempotencyKey: "key-b",
    });
    expect(second.id).not.toBe(first.id);
    expect(sendTransaction).toHaveBeenCalledTimes(2);
  });
  it("creates a new trade every time when no key is sent", async () => {
    acceptSend();
    const first = await createDvpTrade(env, auditContext, tradeInput());
    const second = await createDvpTrade(env, auditContext, tradeInput());
    expect(second.id).not.toBe(first.id);
  });
  it("resolves sponsorship after term validation", async () => {
    await expect(
      createDvpTrade(env, auditContext, {
        ...tradeInput(),
        partyB: { address: address(SETTLEMENT_AUTHORITY) },
      })
    ).rejects.toThrow(/settlementAuthority must not be/);
    expect(createProjectSponsorshipFeePayment).not.toHaveBeenCalled();
    expect(prepareOwnedSubmission).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
    await expect(rowsInDb()).resolves.toEqual([]);
  });
  it("resolves a walletId slot to the wallet's address and stores null attribution", async () => {
    acceptSend();
    const trade = await createDvpTrade(env, auditContext, tradeInput());
    expect(trade.userA).toBe(address(custodyWalletAddress));
    const rows = await rowsInDb();
    expect(rows[0].counterparty_account_id_a).toBeNull();
    expect(rows[0].counterparty_account_id_b).toBeNull();
  });
  it("resolves a counterpartyAccountId slot to the linked address and stores the ref", async () => {
    const db = getDb(env);
    await db
      .prepare(`INSERT INTO counterparties (id, organization_id, project_id, entity_type, display_name)
         VALUES ('cpty_resolve', ?, ?, 'individual', 'Ada')`)
      .bind(TEST_ORG.id, TEST_PROJECT_ID)
      .run();
    await db
      .prepare(`INSERT INTO counterparty_accounts
           (id, organization_id, project_id, counterparty_id, account_kind, details, status)
         VALUES ('cpa_resolve', ?, ?, 'cpty_resolve', 'crypto_wallet',
                 '{"network":"solana","address":"${COUNTERPARTY_ADDRESS}"}'::jsonb, 'active')`)
      .bind(TEST_ORG.id, TEST_PROJECT_ID)
      .run();
    acceptSend();
    const trade = await createDvpTrade(env, auditContext, {
      ...tradeInput(),
      partyA: { counterpartyAccountId: "cpa_resolve" },
      partyB: { address: address("GjupWG8a4BXmduuUQt7vP7QxJ5Kq5YhwKZNkFYp5KPr") },
    });
    expect(trade.userA).toBe(address(COUNTERPARTY_ADDRESS));
    const rows = await rowsInDb();
    expect(rows[0].counterparty_account_id_a).toBe("cpa_resolve");
    expect(rows[0].counterparty_account_id_b).toBeNull();
  });
  it("refuses a counterpartyAccountId slot of the wrong kind", async () => {
    const db = getDb(env);
    await db
      .prepare(`INSERT INTO counterparties (id, organization_id, project_id, entity_type, display_name)
         VALUES ('cpty_bank', ?, ?, 'individual', 'Bo')`)
      .bind(TEST_ORG.id, TEST_PROJECT_ID)
      .run();
    await db
      .prepare(`INSERT INTO counterparty_accounts
           (id, organization_id, project_id, counterparty_id, account_kind, status)
         VALUES ('cpa_bank', ?, ?, 'cpty_bank', 'bank_account', 'active')`)
      .bind(TEST_ORG.id, TEST_PROJECT_ID)
      .run();
    acceptSend();
    await expect(
      createDvpTrade(env, auditContext, {
        ...tradeInput(),
        partyA: { counterpartyAccountId: "cpa_bank" },
      })
    ).rejects.toThrow(/crypto_wallet/);
    await expect(rowsInDb()).resolves.toEqual([]);
  });
  it("refuses an archived counterparty account", async () => {
    const db = getDb(env);
    await db
      .prepare(`INSERT INTO counterparties (id, organization_id, project_id, entity_type, display_name)
         VALUES ('cpty_archived', ?, ?, 'individual', 'Ari')`)
      .bind(TEST_ORG.id, TEST_PROJECT_ID)
      .run();
    await db
      .prepare(`INSERT INTO counterparty_accounts
           (id, organization_id, project_id, counterparty_id, account_kind, status)
         VALUES ('cpa_archived', ?, ?, 'cpty_archived', 'crypto_wallet', 'archived')`)
      .bind(TEST_ORG.id, TEST_PROJECT_ID)
      .run();
    acceptSend();
    await expect(
      createDvpTrade(env, auditContext, {
        ...tradeInput(),
        partyA: { counterpartyAccountId: "cpa_archived" },
      })
    ).rejects.toThrow(/counterpartyAccountId/);
    await expect(rowsInDb()).resolves.toEqual([]);
  });
  it("refuses an unknown walletId", async () => {
    acceptSend();
    await expect(
      createDvpTrade(env, auditContext, {
        ...tradeInput(),
        partyA: { walletId: "cwlt_nonexistent" },
      })
    ).rejects.toThrow(/walletId/);
    await expect(rowsInDb()).resolves.toEqual([]);
  });
  it("refuses an archived wallet", async () => {
    const db = getDb(env);
    const archivedSigner = await generateKeyPairSigner();
    await db
      .prepare(`INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES ('cwlt_archived', ?, 'w_arch', ?, 'archived')`)
      .bind(CUSTODY_CONFIG_ID, archivedSigner.address)
      .run();
    acceptSend();
    await expect(
      createDvpTrade(env, auditContext, {
        ...tradeInput(),
        partyA: { walletId: "cwlt_archived" },
      })
    ).rejects.toThrow(/walletId/);
    await expect(rowsInDb()).resolves.toEqual([]);
  });
  it("uses the sponsor as fee payer and instruction payer in one signature slot", async () => {
    acceptSend();
    const trade = await createDvpTrade(env, auditContext, tradeInput());
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
      movement: "dvp.create",
    });
  });
  it("fails the claim when the port refuses the sponsor response and never attaches a signature", async () => {
    const refusal = new SponsorMessageMismatchError();
    prepareOwnedSubmission.mockRejectedValueOnce(refusal);
    const input = { ...tradeInput(), idempotencyKey: "key-port-integrity" };
    await expect(createDvpTrade(env, auditContext, input)).rejects.toBe(refusal);
    await expect(rowsInDb()).resolves.toMatchObject([
      { status: "create_failed", create_signature: null },
    ]);
  });
  it("fails the claim when Kora denies and frees the key on replay", async () => {
    const denial = new FeePaymentError("Kora rate limit", "RATE_LIMITED");
    prepareOwnedSubmission.mockRejectedValueOnce(denial);
    const input = { ...tradeInput(), idempotencyKey: "key-kora-denial" };
    await expect(createDvpTrade(env, auditContext, input)).rejects.toBe(denial);
    await expect(rowsInDb()).resolves.toMatchObject([{ status: "create_failed" }]);
    const retried = await createDvpTrade(env, auditContext, input);
    expect(retried.status).toBe("creating");
    await expect(rowsInDb()).resolves.toHaveLength(2);
  });
});
