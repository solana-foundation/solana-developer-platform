import { runInClusterScope } from "@sdp/rpc/scope";
import { MEMO_PROGRAM_ADDRESS } from "@sdp/types/well-known-programs";
import {
  address,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  generateKeyPair,
  getAddressFromPublicKey,
  getSignatureFromTransaction,
  getTransactionEncoder,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import {
  createPostgresEarnSplitSwapAdvisoriesRepository,
  generateEarnSplitSwapAdvisoryId,
} from "@/db/repositories/earn-split-swap-advisories.repository";
import { installClusterRpcResponder } from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import {
  observePreparedSwapStrategyAction,
  requirePreparedSwapStrategyTransaction,
  retryPreparedSwapStrategyAction,
  submitPreparedSwapStrategyAction,
  swapStrategySigningTarget,
} from "./strategy-swap-operations.service";

const broadcast = vi.hoisted(() => vi.fn());
vi.mock("./vault-execution.service", async (original) => ({
  ...(await original<typeof import("./vault-execution.service")>()),
  broadcastVaultTransaction: broadcast,
}));

const rpc = installClusterRpcResponder();
const ORG = "org_strategy_swap";
const USER = "user_strategy_swap";
const scope = { organizationId: ORG, projectId: `prj_${ORG}_sandbox`, custodyWalletId: null };
const depositMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const repository = () => createPostgresEarnSplitSwapAdvisoriesRepository(getDb(env));
const scopedRepositoryInput = () => ({ ...scope, environment: "sandbox" as const });
const inScope = <T>(work: () => T): T =>
  runInClusterScope({ projectId: scope.projectId, environment: "sandbox" }, work);

let keyPair: CryptoKeyPair;
let owner: string;
let unsigned: string;
let signed: string;
let transactionSignature: string;

async function transaction(message: string) {
  const compiled = compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (value) => setTransactionMessageFeePayer(address(owner), value),
      (value) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: blockhash("11111111111111111111111111111111"),
            lastValidBlockHeight: 100n,
          },
          value
        ),
      (value) =>
        appendTransactionMessageInstruction(
          {
            programAddress: MEMO_PROGRAM_ADDRESS,
            accounts: [],
            data: new TextEncoder().encode(message),
          },
          value
        )
    )
  );
  const authorized = await partiallySignTransaction([keyPair], compiled);
  return {
    unsigned: Buffer.from(getTransactionEncoder().encode(compiled)).toString("base64"),
    signed: Buffer.from(getTransactionEncoder().encode(authorized)).toString("base64"),
    signature: getSignatureFromTransaction(authorized),
  };
}

async function create(
  custodyWalletId?: string,
  unsignedTransaction: string | undefined = unsigned
) {
  return repository().create({
    id: generateEarnSplitSwapAdvisoryId(),
    ...scope,
    environment: "sandbox",
    provider: "kamino",
    strategyId: "strategy",
    vaultAddress: "provider-vault",
    ownerAddress: owner,
    custodyWalletId,
    unsignedTransaction,
    sourceTokenMint: "So11111111111111111111111111111111111111112",
    depositTokenMint: depositMint,
    depositTokenDecimals: 6,
    swapSourceAmount: "1",
    swapMinOutAmount: "24.8",
    swapMinOutAtoms: "24800000",
    swapLastValidBlockHeight: "100",
    baselineDepositTokenAtoms: "0",
  });
}

beforeEach(async () => {
  await seedTestDatabase(env);
  const db = getDb(env);
  await db.execute(
    "INSERT INTO users (id, email, email_verified, status) VALUES (?, 'swap@example.com', 1, 'active')",
    [USER]
  );
  await db.execute(
    "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')",
    [ORG, ORG, ORG]
  );
  await seedDefaultProjects(db, { organizationId: ORG, createdBy: USER, members: [USER] });
  keyPair = await generateKeyPair();
  owner = await getAddressFromPublicKey(keyPair.publicKey);
  const built = await transaction("reviewed swap");
  unsigned = built.unsigned;
  signed = built.signed;
  transactionSignature = built.signature;
  broadcast.mockReset();
  broadcast.mockResolvedValue(undefined);
  rpc.respondSignatureStatuses(() => null);
  rpc.answer("getBlockHeight", 50);
});

async function submit(advisoryId: string, shouldBroadcast = true) {
  return inScope(() =>
    submitPreparedSwapStrategyAction(env, {
      ...scope,
      advisoryId,
      signedTransaction: signed,
      broadcast: shouldBroadcast,
    })
  );
}

async function observe(advisoryId: string) {
  return inScope(() => observePreparedSwapStrategyAction(env, scope, advisoryId));
}

const statusReads = () => rpc.calls.filter((call) => call.method === "getSignatureStatuses").length;

describe("durable strategy swap prerequisites", () => {
  it("retains immutable bytes and refuses a different project, wallet or environment", async () => {
    const row = await create("wallet");
    const target = await inScope(() =>
      requirePreparedSwapStrategyTransaction(env, { ...scope, custodyWalletId: "wallet" }, row.id)
    );
    expect(swapStrategySigningTarget(target)).toMatchObject({
      owner_address: owner,
      unsigned_transaction: unsigned,
      fee_mode: "wallet",
      movement: "earn.deposit",
    });
    await expect(
      inScope(() => requirePreparedSwapStrategyTransaction(env, scope, row.id))
    ).rejects.toThrow("Prepared strategy swap");
    expect(
      await repository().getForOperation(
        { ...scopedRepositoryInput(), custodyWalletId: "wallet", projectId: "other" },
        row.id
      )
    ).toBeNull();
    expect(
      await repository().getForOperation(
        { ...scopedRepositoryInput(), custodyWalletId: "wallet", environment: "production" },
        row.id
      )
    ).toBeNull();
    expect(rpc.calls).toHaveLength(0);
  });

  it("persists the exact signature before sending and never records a deposit movement", async () => {
    const row = await create();
    broadcast.mockImplementation(async () => {
      const persisted = await repository().getForOperation(scopedRepositoryInput(), row.id);
      expect(persisted?.swap_signature).toBe(transactionSignature);
    });
    await expect(submit(row.id)).resolves.toEqual({ kind: "earn.swap", id: row.id });
    await submit(row.id);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0]?.[0].bytes).toEqual(
      Uint8Array.from(Buffer.from(signed, "base64"))
    );
    const movements = await getDb(env).queryOne<{ count: string }>(
      "SELECT count(*) FROM earn_movements"
    );
    expect(Number(movements?.count)).toBe(0);
  });

  it("refuses a valid owner signature over a changed message before persistence or send", async () => {
    const row = await create();
    const changed = await transaction("unreviewed different transaction");
    await expect(
      inScope(() =>
        submitPreparedSwapStrategyAction(env, {
          ...scope,
          advisoryId: row.id,
          signedTransaction: changed.signed,
          broadcast: true,
        })
      )
    ).rejects.toThrow("does not match the built transaction");
    expect(
      (await repository().getForOperation(scopedRepositoryInput(), row.id))?.swap_signature
    ).toBeNull();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("serializes one signature and refuses replacing it under concurrent retries", async () => {
    const row = await create();
    const results = await Promise.all([
      repository().recordOperationSignature(scopedRepositoryInput(), row.id, transactionSignature),
      repository().recordOperationSignature(scopedRepositoryInput(), row.id, transactionSignature),
    ]);
    expect(results.map((result) => result?.replayed).sort()).toEqual([false, true]);
    expect(
      await repository().recordOperationSignature(
        scopedRepositoryInput(),
        row.id,
        "different-signature"
      )
    ).toBeNull();
  });

  it("keeps missing signature history unknown without an expiry read", async () => {
    const row = await create();
    await submit(row.id);
    rpc.answer("getBlockHeight", 1_000);
    expect(await observe(row.id)).toMatchObject({
      status: "submitted",
      observed: false,
      continuation: null,
    });
    expect(statusReads()).toBe(1);
    expect(rpc.calls.some((call) => call.method === "getBlockHeight")).toBe(false);
    expect(
      (await repository().getForOperation(scopedRepositoryInput(), row.id))?.swap_failure_reason
    ).toBeNull();
  });

  it("retains finalized proof and exposes a reviewable continuation without inventing proceeds", async () => {
    const row = await create();
    await submit(row.id);
    rpc.respondSignatureStatuses(() => ({
      slot: 42,
      confirmations: null,
      confirmationStatus: "finalized",
      err: null,
    }));
    expect(await observe(row.id)).toMatchObject({
      status: "finalized",
      finalizationSlot: "42",
      continuation: {
        strategyId: "strategy",
        source: { ownerAddress: owner },
        depositTokenMint: depositMint,
        minOutAmount: "24.8",
      },
    });
    rpc.respondSignatureStatuses(() => null);
    expect(await observe(row.id)).toMatchObject({ status: "finalized", finalizationSlot: "42" });
    expect(statusReads()).toBe(1);
  });

  it.each(["processed", "confirmed", "finalized"] as const)(
    "only treats a finalized chain error as terminal (%s)",
    async (commitment) => {
      const row = await create();
      await submit(row.id);
      rpc.respondSignatureStatuses(() => ({
        slot: 42,
        confirmations: 1,
        confirmationStatus: commitment,
        err: { InstructionError: [0, { Custom: 1 }] },
      }));
      const result = await observe(row.id);
      expect(result.status).toBe(commitment === "finalized" ? "failed" : "submitted");
      expect(result.continuation).toBeNull();
    }
  );

  it("recovers the exact signed outbox after a crash between persistence and broadcast", async () => {
    const row = await create();
    broadcast.mockRejectedValueOnce(new Error("lost send outcome"));
    await expect(submit(row.id)).rejects.toThrow("lost send outcome");
    expect(await observe(row.id)).toMatchObject({ observed: false, status: "submitted" });
    await expect(
      inScope(() =>
        retryPreparedSwapStrategyAction(env, {
          ...scope,
          advisoryId: row.id,
          signedTransaction: signed,
        })
      )
    ).resolves.toBe(true);
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast.mock.calls[0]?.[0].bytes).toEqual(broadcast.mock.calls[1]?.[0].bytes);
    expect(rpc.calls.filter((call) => call.method === "getBlockHeight")).toHaveLength(1);
  });

  it("stops retry sends after expiry while retaining the unresolved signature", async () => {
    const row = await create();
    await submit(row.id);
    rpc.answer("getBlockHeight", 101);
    await expect(
      inScope(() =>
        retryPreparedSwapStrategyAction(env, {
          ...scope,
          advisoryId: row.id,
          signedTransaction: signed,
        })
      )
    ).resolves.toBe(false);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(await observe(row.id)).toMatchObject({ status: "submitted", continuation: null });
  });

  it("adopts cancelled signed bytes only after observing their existing signature", async () => {
    const row = await create();
    await expect(submit(row.id, false)).rejects.toThrow(
      "waiting for the original swap signature observation"
    );
    expect(
      (await repository().getForOperation(scopedRepositoryInput(), row.id))?.swap_signature
    ).toBeNull();
    rpc.respondSignatureStatuses(() => ({
      slot: 42,
      confirmations: null,
      confirmationStatus: "finalized",
      err: null,
    }));
    await submit(row.id, false);
    expect(broadcast).not.toHaveBeenCalled();
    expect(await observe(row.id)).toMatchObject({ status: "finalized", finalizationSlot: "42" });
  });
});
