import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { parseDecimalAmount } from "@sdp/solana/amount";
import type { Instruction } from "@solana/kit";
import {
  address,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toEarnVaultTransactionPlan } from "./client";
import { vedaClusterConfig } from "./programs";
import { VEDA_REQUEST_WITHDRAW_DISCRIMINATOR } from "./queue-rent";
import {
  buildVedaDepositPlan,
  buildVedaQueuedWithdrawalCancelPlan,
  buildVedaQueuedWithdrawalRequestPlan,
  parseVedaWithdrawalLifecycleEvents,
  previewVedaDeposit,
  previewVedaQueuedWithdrawal,
  readVedaPosition,
  readVedaQueuedWithdrawalRequest,
  readVedaQueuedWithdrawalRequests,
  readVedaWithdrawalOptions,
} from "./sdk";
import type { VedaInstructionPlan, VedaRuntime } from "./types";

/**
 * Real-program proof for Veda's delayed withdrawal path.
 *
 * This suite is opt-in because it needs a Surfpool surfnet with a DEVNET remote
 * RPC. Surfpool lazily clones Veda's deployed vault, queue and transfer-hook
 * programs; the only cheatcodes used are test-wallet funding and deterministic
 * clock control. The Veda accounts, program bytecode, instructions and refusal
 * rules are never mocked or rewritten.
 *
 * Run it through the container-only entrypoint (never host Node/pnpm):
 *
 *   VEDA_SURFPOOL_DEVNET_RPC_URL=<devnet RPC> scripts/kora-surfpool/e2e-veda.sh
 *
 * The queue's solver is deliberately out of scope. Fulfilment requires Veda's
 * private solve-authority signer, which a fork does not and must not impersonate.
 */
const ENABLED = process.env.VEDA_SURFPOOL_E2E === "true";
const RPC_URL = process.env.SOLANA_RPC_URL;
const DEPOSIT_AMOUNT = "2";
const FUNDED_USDC_ATOMS = 10_000_000n;
const OWNER_LAMPORTS = 10_000_000_000;
const CLOCK_SYSVAR = "SysvarC1ock11111111111111111111111111111111";

type RpcResponse<T> =
  | { jsonrpc: "2.0"; id: number; result: T }
  | { jsonrpc: "2.0"; id: number; error: { code: number; message: string; data?: unknown } };

type SimulationValue = {
  err: unknown;
  logs: readonly string[] | null;
};

async function rpcCall<T>(method: string, params: readonly unknown[] = []): Promise<T> {
  if (!RPC_URL) throw new Error("SOLANA_RPC_URL is required for the Veda Surfpool proof");
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = (await response.json()) as RpcResponse<T>;
  if ("error" in payload) {
    throw new Error(`${method} failed: ${payload.error.message}`);
  }
  return payload.result;
}

async function cheat(method: string, params: readonly unknown[] = []): Promise<unknown> {
  return await rpcCall(method, params);
}

async function waitForSignature(signature: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const statuses = await rpcCall<{
      value: Array<{ err: unknown; confirmationStatus?: string } | null>;
    }>("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
    const status = statuses.value[0];
    if (status) {
      expect(status.err).toBeNull();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Surfpool did not observe transaction ${signature}`);
}

async function finalizedTransactionLogs(signature: string): Promise<readonly string[]> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const transaction = await rpcCall<{
      meta: { err: unknown; logMessages: readonly string[] | null };
    } | null>("getTransaction", [
      signature,
      { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 },
    ]);
    if (transaction) {
      expect(transaction.meta.err).toBeNull();
      return transaction.meta.logMessages ?? [];
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Surfpool did not return finalized transaction logs for ${signature}`);
}

async function readSurfpoolClock(): Promise<{ slot: bigint; unixTimestamp: bigint }> {
  const account = await rpcCall<{
    value: { data: [string, "base64"] } | null;
  }>("getAccountInfo", [CLOCK_SYSVAR, { encoding: "base64", commitment: "confirmed" }]);
  if (!account.value) throw new Error("Surfpool did not return its Clock sysvar");
  const data = Buffer.from(account.value.data[0], "base64");
  if (data.byteLength < 40) {
    throw new Error(`Surfpool returned a ${data.byteLength}-byte Clock sysvar`);
  }
  return {
    slot: data.readBigUInt64LE(0),
    unixTimestamp: data.readBigInt64LE(32),
  };
}

async function setSurfpoolClockUnixSecond(timestamp: bigint): Promise<void> {
  const account = await rpcCall<{
    value: { data: [string, "base64"] } | null;
  }>("getAccountInfo", [CLOCK_SYSVAR, { encoding: "base64", commitment: "confirmed" }]);
  if (!account.value) throw new Error("Surfpool did not return its Clock sysvar");
  const data = Buffer.from(account.value.data[0], "base64");
  if (data.byteLength < 40) {
    throw new Error(`Surfpool returned a ${data.byteLength}-byte Clock sysvar`);
  }
  data.writeBigInt64LE(timestamp, 32);
  // Surfpool does not support backwards `surfnet_timeTravel`. Updating only
  // the Clock sysvar is the supported deterministic test control here; no
  // Veda program, request, escrow, mint or token balance is rewritten.
  await cheat("surfnet_setAccount", [CLOCK_SYSVAR, { data: data.toString("hex") }]);
  expect((await readSurfpoolClock()).unixTimestamp).toBe(timestamp);
}

async function proxyRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!RPC_URL) throw new Error("SOLANA_RPC_URL is required for the Veda Surfpool proof");
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  const rpcRequest = JSON.parse(body) as {
    method?: string;
    params?: Array<Record<string, unknown> | unknown>;
  };
  const upstream = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const payload = (await upstream.json()) as {
    result?: { context?: { slot: number } };
  };

  if (rpcRequest.method === "getMultipleAccounts" && payload.result?.context) {
    payload.result.context.slot = Number((await readSurfpoolClock()).slot);
  }
  if (rpcRequest.method === "getBlockTime" && "result" in payload) {
    const requestedSlot = rpcRequest.params?.[0];
    const clock = await readSurfpoolClock();
    if (Number(requestedSlot) === Number(clock.slot)) {
      payload.result = Number(clock.unixTimestamp) as never;
    }
  }

  response.statusCode = upstream.status;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(payload));
}

async function startContextAlignedRpc(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    proxyRequest(request, response).catch((error: unknown) => {
      response.statusCode = 500;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32_603, message: error instanceof Error ? error.message : String(error) },
        })
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const bound = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${bound.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function travelToUnixSecond(timestamp: bigint): Promise<void> {
  // The raw Surfpool JSON cheatcode takes Unix milliseconds even though the
  // Solana Clock and Veda's accounts expose Unix seconds.
  const timestampMilliseconds = Number(timestamp * 1_000n);
  expect(Number.isSafeInteger(timestampMilliseconds)).toBe(true);
  await cheat("surfnet_timeTravel", [{ absoluteTimestamp: timestampMilliseconds }]);
  // Surfpool applies a paused time-travel target when its clock is resumed.
  // Resume just long enough to observe that bank, then freeze the target time
  // again so the assertions and transactions below stay deterministic.
  await cheat("surfnet_resumeClock");
  let observed: { slot: bigint; unixTimestamp: bigint } | undefined;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    observed = await readSurfpoolClock();
    if (observed.unixTimestamp >= timestamp) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await cheat("surfnet_pauseClock");
  if (!observed) throw new Error("Surfpool did not return its Clock after time travel");
  expect(observed.unixTimestamp).toBeGreaterThanOrEqual(timestamp);
}

function oneAtom(decimals: number): string {
  if (decimals === 0) return "1";
  return `0.${"0".repeat(decimals - 1)}1`;
}

/** Exercise the same provider -> plain plan -> Kit boundary the API executes. */
function executionInstructions(plan: VedaInstructionPlan): readonly Instruction[] {
  return toEarnVaultTransactionPlan(plan).instructions.map(
    (instruction) =>
      ({
        programAddress: address(instruction.programAddress),
        accounts: instruction.accounts.map((account) => ({
          address: address(account.address),
          role: account.role,
        })),
        data: Uint8Array.from(Buffer.from(instruction.data, "base64")),
      }) as unknown as Instruction
  );
}

async function compilePlan(
  plan: VedaInstructionPlan,
  owner: Awaited<ReturnType<typeof generateKeyPairSigner>>
) {
  expect(plan.lookupTables).toEqual([]);
  const rpc = createSolanaRpc(RPC_URL ?? "");
  const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(owner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions(executionInstructions(plan), m)
  );
  return getBase64EncodedWireTransaction(await signTransactionMessageWithSigners(message));
}

async function simulatePlan(
  plan: VedaInstructionPlan,
  owner: Awaited<ReturnType<typeof generateKeyPairSigner>>
): Promise<SimulationValue> {
  const rpc = createSolanaRpc(RPC_URL ?? "");
  const wire = await compilePlan(plan, owner);
  const simulation = await rpc.simulateTransaction(wire, { encoding: "base64" }).send();
  return simulation.value;
}

async function sendPlan(
  plan: VedaInstructionPlan,
  owner: Awaited<ReturnType<typeof generateKeyPairSigner>>
): Promise<string> {
  const rpc = createSolanaRpc(RPC_URL ?? "");
  const wire = await compilePlan(plan, owner);
  const simulation = await rpc.simulateTransaction(wire, { encoding: "base64" }).send();
  expect(
    simulation.value.err,
    `simulation failed:\n${simulation.value.logs?.join("\n") ?? "<no logs>"}`
  ).toBeNull();

  const signature = String(
    await rpc
      .sendTransaction(wire, {
        encoding: "base64",
        skipPreflight: false,
        preflightCommitment: "confirmed",
      })
      .send()
  );
  await waitForSignature(signature);
  return signature;
}

async function tokenBalanceAtoms(tokenAccount: string): Promise<bigint> {
  const balance = await rpcCall<{ value: { amount: string } }>("getTokenAccountBalance", [
    tokenAccount,
    { commitment: "confirmed" },
  ]);
  return BigInt(balance.value.amount);
}

async function accountExists(account: string): Promise<boolean> {
  const info = await rpcCall<{ value: object | null }>("getAccountInfo", [
    account,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  return info.value !== null;
}

describe.skipIf(!ENABLED || !RPC_URL)("Veda queued withdrawals on Surfpool", () => {
  let providerRpcUrl = RPC_URL ?? "";
  const runtime = (): VedaRuntime => ({ cluster: "devnet", rpcUrl: providerRpcUrl });
  const config = vedaClusterConfig("devnet");
  const vault = config.vaultStateAddresses[0];
  let owner: Awaited<ReturnType<typeof generateKeyPairSigner>>;
  let contextAlignedRpc: Awaited<ReturnType<typeof startContextAlignedRpc>> | undefined;
  let clockPaused = false;

  async function alignProviderRpcContext(): Promise<void> {
    if (contextAlignedRpc) return;
    contextAlignedRpc = await startContextAlignedRpc();
    providerRpcUrl = contextAlignedRpc.url;
  }

  beforeAll(async () => {
    if (!vault) throw new Error("The Veda devnet deployment has no configured vault");
    owner = await generateKeyPairSigner();

    // A remote Surfnet seeds its clock before lazy account clones. Move the
    // fork safely ahead, then freeze it so the early-cancel assertion cannot
    // race a short deadline.
    const slot = await rpcCall<number>("getSlot", [{ commitment: "confirmed" }]);
    await cheat("surfnet_timeTravel", [{ absoluteSlot: slot + 10_000 }]);
    await cheat("surfnet_pauseClock");
    clockPaused = true;

    await cheat("surfnet_setAccount", [
      owner.address,
      {
        lamports: OWNER_LAMPORTS,
        owner: "11111111111111111111111111111111",
        data: "",
        executable: false,
        rentEpoch: 0,
      },
    ]);
  }, 120_000);

  afterAll(async () => {
    await contextAlignedRpc?.close();
    if (clockPaused) await cheat("surfnet_resumeClock").catch(() => undefined);
  });

  it("lands deposit -> request, refuses early cancel, then expires -> cancels and returns shares", async () => {
    if (!vault) throw new Error("The Veda devnet deployment has no configured vault");
    const queueProgramAddress = config.queueProgramAddress;
    if (!queueProgramAddress) {
      throw new Error("The Veda devnet deployment has no configured queue program");
    }

    const options = await readVedaWithdrawalOptions(runtime(), config, { vault });
    expect(options.queued).toBe(true);
    expect(options.queueState).not.toBeNull();
    const queueAsset = options.queueAsset;
    if (!queueAsset) throw new Error("The Veda devnet vault has no queued-withdrawal asset");
    expect(queueAsset.allowWithdrawals).toBe(true);

    await cheat("surfnet_setTokenAccount", [
      owner.address,
      queueAsset.assetMint,
      { amount: Number(FUNDED_USDC_ATOMS) },
    ]);

    const depositQuote = await previewVedaDeposit(runtime(), config, {
      vault,
      amount: DEPOSIT_AMOUNT,
    });
    expect(depositQuote.issues).toEqual([]);
    const depositPlan = await buildVedaDepositPlan(runtime(), config, {
      vault,
      owner: owner.address,
      amount: DEPOSIT_AMOUNT,
      minSharesOut: oneAtom(depositQuote.shareDecimals),
    });
    expect(await sendPlan(depositPlan, owner)).toBeTruthy();

    const deposited = await readVedaPosition(runtime(), config, {
      vault,
      owner: owner.address,
    });
    const depositedAtoms = parseDecimalAmount(deposited.shares, queueAsset.shareDecimals);
    const requestAtoms = parseDecimalAmount(queueAsset.minimumShares, queueAsset.shareDecimals);
    expect(depositedAtoms).toBeGreaterThanOrEqual(requestAtoms);

    // A deployment may impose a post-deposit share lock. Advance the real
    // Surfpool clock beyond it before asking the queue program to escrow the
    // shares. (The queue delay itself is still tested separately below.)
    if (deposited.unlockTimestamp && BigInt(deposited.unlockTimestamp) > 0n) {
      await travelToUnixSecond(BigInt(deposited.unlockTimestamp) + 1n);
      await alignProviderRpcContext();
    }

    const requestInput = {
      vault,
      owner: owner.address,
      shares: queueAsset.minimumShares,
      discountBps: queueAsset.minimumDiscountBps,
      deadlineSeconds: queueAsset.minimumSecondsToDeadline,
    };
    const requestQuote = await previewVedaQueuedWithdrawal(runtime(), config, requestInput);
    expect(requestQuote.issues).toEqual([]);
    const requestPlan = await buildVedaQueuedWithdrawalRequestPlan(runtime(), config, requestInput);

    // Pinned to boring_onchain_queue.json's request_withdraw account order:
    // queue_shares is account 9. This is the actual escrow account the real
    // instruction will mutate, not a balance invented by the test.
    const queueInstruction = requestPlan.instructions.find(
      (instruction) =>
        String(instruction.programAddress) === String(queueProgramAddress) &&
        VEDA_REQUEST_WITHDRAW_DISCRIMINATOR.every(
          (byte, index) => instruction.data?.[index] === byte
        )
    );
    const queueEscrow = queueInstruction?.accounts?.[9]?.address;
    if (!queueEscrow) throw new Error("Veda request plan did not name its queue share escrow");

    const escrowBefore = await tokenBalanceAtoms(String(queueEscrow));
    expect(await accountExists(String(requestPlan.requestAddress))).toBe(false);
    const requestSignature = await sendPlan(requestPlan, owner);
    expect(requestSignature).toBeTruthy();

    const eventScales = {
      queueProgramAddress,
      shareDecimals: requestQuote.shareDecimals,
      assetDecimals: requestQuote.assetDecimals,
    };
    const requestEvents = parseVedaWithdrawalLifecycleEvents(
      await finalizedTransactionLogs(requestSignature),
      eventScales
    );
    expect(requestEvents).toContainEqual(
      expect.objectContaining({
        kind: "withdrawalRequested",
        queueState: options.queueState,
        requestAddress: requestPlan.requestAddress,
        owner: owner.address,
        assetMint: requestPlan.expectedRequest.assetMint,
        shares: requestPlan.expectedRequest.shares,
        assets: requestPlan.expectedRequest.assets,
        maturityTimestamp: requestPlan.expectedRequest.maturityTimestamp,
        deadlineTimestamp: requestPlan.expectedRequest.deadlineTimestamp,
      })
    );

    expect(await accountExists(String(requestPlan.requestAddress))).toBe(true);
    expect(await tokenBalanceAtoms(String(queueEscrow))).toBe(escrowBefore + requestAtoms);
    const afterRequest = await readVedaPosition(runtime(), config, {
      vault,
      owner: owner.address,
    });
    expect(parseDecimalAmount(afterRequest.shares, queueAsset.shareDecimals)).toBe(
      depositedAtoms - requestAtoms
    );

    const liveLookup = await readVedaQueuedWithdrawalRequest(runtime(), config, {
      vault,
      request: requestPlan.requestAddress,
    });
    expect(["pending", "fulfillable"]).toContain(liveLookup.status);
    if (liveLookup.request === null) {
      throw new Error("The landed Veda withdrawal request was reported closed");
    }
    const liveRequest = liveLookup.request;
    expect(liveRequest).toMatchObject({
      requestAddress: requestPlan.requestAddress,
      owner: owner.address,
      assetMint: requestPlan.expectedRequest.assetMint,
      shares: requestPlan.expectedRequest.shares,
      assets: requestPlan.expectedRequest.assets,
      maturityTimestamp: requestPlan.expectedRequest.maturityTimestamp,
      deadlineTimestamp: requestPlan.expectedRequest.deadlineTimestamp,
    });
    expect(liveRequest.status).toBe(liveLookup.status);
    const listed = await readVedaQueuedWithdrawalRequests(runtime(), config, {
      vault,
      owner: owner.address,
    });
    expect(listed.map((request) => request.requestAddress)).toContain(requestPlan.requestAddress);

    const deadlineSeconds = BigInt(requestPlan.expectedRequest.deadlineTimestamp);
    const creationSeconds = BigInt(liveRequest.creationTimestamp);
    const beforeDeadlineSeconds = creationSeconds + (deadlineSeconds - creationSeconds) / 2n;
    expect(beforeDeadlineSeconds).toBeGreaterThan(creationSeconds);
    expect(beforeDeadlineSeconds).toBeLessThan(deadlineSeconds);

    // The pinned SDK correctly refuses to *build* a cancellation before its
    // deadline. That guard alone does not prove the deployed queue program's
    // rule, so first move past the deadline and build the real instruction.
    await travelToUnixSecond(deadlineSeconds + 1n);
    // Surfpool 1.5 advances its current bank and Clock correctly, but account
    // reads keep the original fork slot in `context.slot`. Veda intentionally
    // derives `now` through getBlockTime(context.slot). This local pass-through
    // aligns only that context with Surfpool's own current slot; account bytes,
    // block time, instructions and every Veda program execution stay upstream.
    await alignProviderRpcContext();

    const expired = await readVedaQueuedWithdrawalRequest(runtime(), config, {
      vault,
      request: requestPlan.requestAddress,
    });
    expect(expired.status).toBe("expiredCancelable");

    const cancelPlan = await buildVedaQueuedWithdrawalCancelPlan(runtime(), config, {
      vault,
      owner: owner.address,
      request: requestPlan.requestAddress,
    });

    // Set only the actual Surfpool Clock back before the deadline, then
    // simulate the exact instruction that will later land. The failure must
    // come from Veda's real queue program and name its deadline rule—not from
    // our SDK preflight guard. All Veda-owned state remains untouched.
    await setSurfpoolClockUnixSecond(beforeDeadlineSeconds);
    const refused = await simulatePlan(cancelPlan, owner);
    expect(refused.err).not.toBeNull();
    expect(refused.logs?.join("\n") ?? "").toMatch(/invalid_queue_parameters|deadline/i);
    expect(await accountExists(String(requestPlan.requestAddress))).toBe(true);

    await setSurfpoolClockUnixSecond(deadlineSeconds + 1n);
    expect(
      (
        await readVedaQueuedWithdrawalRequest(runtime(), config, {
          vault,
          request: requestPlan.requestAddress,
        })
      ).status
    ).toBe("expiredCancelable");

    const cancelSignature = await sendPlan(cancelPlan, owner);
    expect(cancelSignature).toBeTruthy();
    const cancelEvents = parseVedaWithdrawalLifecycleEvents(
      await finalizedTransactionLogs(cancelSignature),
      eventScales
    );
    expect(cancelEvents).toContainEqual(
      expect.objectContaining({
        kind: "withdrawalCancelled",
        queueState: options.queueState,
        requestAddress: requestPlan.requestAddress,
        owner: owner.address,
        assetMint: requestPlan.expectedRequest.assetMint,
        sharesReturned: requestPlan.expectedRequest.shares,
      })
    );

    expect(await accountExists(String(requestPlan.requestAddress))).toBe(false);
    expect(await tokenBalanceAtoms(String(queueEscrow))).toBe(escrowBefore);
    const restored = await readVedaPosition(runtime(), config, {
      vault,
      owner: owner.address,
    });
    expect(parseDecimalAmount(restored.shares, queueAsset.shareDecimals)).toBe(depositedAtoms);
    expect(
      await readVedaQueuedWithdrawalRequest(runtime(), config, {
        vault,
        request: requestPlan.requestAddress,
      })
    ).toEqual({
      requestAddress: requestPlan.requestAddress,
      status: "closedOrUnknown",
      request: null,
    });
    expect(
      (
        await readVedaQueuedWithdrawalRequests(runtime(), config, {
          vault,
          owner: owner.address,
        })
      ).map((request) => request.requestAddress)
    ).not.toContain(requestPlan.requestAddress);
  }, 240_000);
});
