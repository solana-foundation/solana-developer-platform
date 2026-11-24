import type { EarnVaultTransactionPlan } from "@sdp/earn/types";
import type { FeePaymentPort } from "@sdp/fee-payment/port";
import * as factory from "@sdp/rpc/factory";
import { runInClusterScope } from "@sdp/rpc/scope";
import * as solanaRpc from "@sdp/rpc/solana";
import { GENESIS_HASH_BY_CLUSTER } from "@sdp/types/well-known-tokens";
import {
  AccountRole,
  type Address,
  address,
  type Blockhash,
  createNoopSigner,
  generateKeyPairSigner,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Signature,
} from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseJsonRpcRequest } from "@/test/helpers/cluster-rpc";
import { fetchFailedError, rpcHttpError } from "@/test/helpers/rpc-errors";
import { createVaultDeadline } from "./vault-deadline";
import * as execution from "./vault-execution.service";
import { VaultTransactionTooLargeError } from "./vault-execution.service";

/** Each stage in the cluster scope a Sandbox request opens, as every caller runs it. */
function inSandbox<TArgs extends unknown[], TResult>(
  operation: (...args: TArgs) => TResult
): (...args: TArgs) => TResult {
  return (...args) =>
    runInClusterScope({ projectId: null, environment: "sandbox" }, () => operation(...args));
}

const broadcastVaultTransaction = inSandbox(execution.broadcastVaultTransaction);
const compileUnsignedVaultTransaction = inSandbox(execution.compileUnsignedVaultTransaction);
const simulateVaultPlan = inSandbox(execution.simulateVaultPlan);

const ownerAddress = address("11111111111111111111111111111112");
const feePayerAddress = address("4YhMUz8xDgHMPAevvfMpnJX9TJmw9DTNDA1sNWPRZG9q");
const blockhash = "29d2S7vB453rNYFdR5Ycwt7y9haRT5fwVwL9zTmBhfV2" as Blockhash;
const signature =
  "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature;

const plan: EarnVaultTransactionPlan = {
  cluster: "devnet",
  instructions: [
    {
      programAddress: "11111111111111111111111111111111",
      accounts: [],
      data: "",
    },
  ],
  lookupTables: [],
  assetIdentity: {
    depositTokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    shareMint: "So11111111111111111111111111111111111111112",
  },
};

const simulateSend = vi.fn();
const lookupTableSend = vi.fn();
/** Base64 wire transactions handed to `simulateTransaction`, newest last. */
const simulatedWire: string[] = [];
const rpc = {
  getMultipleAccounts: vi.fn(() => ({ send: lookupTableSend })),
  simulateTransaction: (wire: string) => {
    simulatedWire.push(wire);
    return { send: simulateSend };
  },
};

/** The fee payer of a compiled transaction is always static account index 0. */
function feePayerOf(wire: string): string {
  const decoded = getTransactionDecoder().decode(Buffer.from(wire, "base64"));
  const payer = Object.keys(decoded.signatures)[0];
  if (!payer) throw new Error("compiled transaction has no signer slots");
  return payer;
}

function feePayment(overrides: Partial<FeePaymentPort> = {}): FeePaymentPort {
  return {
    providerId: "test",
    getFeePayer: vi.fn().mockResolvedValue(feePayerAddress),
    signAsFeePayer: vi.fn().mockImplementation(async (bytes: Uint8Array) => bytes),
    getSponsorshipConfiguration: vi.fn(),
    ...overrides,
  } as FeePaymentPort;
}

function planForOwner(owner: Address): EarnVaultTransactionPlan {
  return {
    ...plan,
    instructions: [
      {
        programAddress: "11111111111111111111111111111111",
        accounts: [{ address: owner, role: AccountRole.READONLY_SIGNER }],
        data: "",
      },
    ],
  };
}

beforeEach(() => {
  simulatedWire.length = 0;
  simulateSend.mockReset().mockResolvedValue({ value: { err: null, logs: [] } });
  lookupTableSend.mockReset();
  rpc.getMultipleAccounts.mockClear();
  vi.spyOn(factory, "createClusterRpc").mockReturnValue(rpc as never);
  vi.spyOn(solanaRpc, "getRecentBlockhash").mockResolvedValue({
    blockhash,
    lastValidBlockHeight: 100n,
  });
  vi.spyOn(solanaRpc, "sendTransaction").mockResolvedValue(signature);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

let poolSequence = 0;

/**
 * Run the real scope client against a devnet pool endpoint no earlier test proved
 * (the pool's genesis proofs outlive a test) whose genesis probe answers
 * `genesis`, recording every JSON-RPC method that reaches it.
 */
function useRealPoolWithDevnetGenesis(genesis: string): string[] {
  vi.mocked(factory.createClusterRpc).mockRestore();
  vi.mocked(solanaRpc.getRecentBlockhash).mockRestore();
  vi.mocked(solanaRpc.sendTransaction).mockRestore();
  poolSequence += 1;
  vi.stubEnv(
    "SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL",
    `https://devnet-${poolSequence}.vault-execution.test`
  );
  const methods: string[] = [];
  vi.stubGlobal("fetch", async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const { id, method } = parseJsonRpcRequest(init);
    methods.push(method);
    if (method !== "getGenesisHash") throw new Error(`${method} reached a mismatched endpoint`);
    return Response.json({ jsonrpc: "2.0", id, result: genesis });
  });
  return methods;
}

describe("vault execution validation", () => {
  it("refuses caller-signed transactions that require any signer besides the owner", async () => {
    const extraSigner = await generateKeyPairSigner();
    const walletPlan: EarnVaultTransactionPlan = {
      ...plan,
      instructions: [
        {
          programAddress: "11111111111111111111111111111111",
          accounts: [{ address: extraSigner.address, role: AccountRole.READONLY_SIGNER }],
          data: "",
        },
      ],
    };

    expect(() =>
      compileUnsignedVaultTransaction({
        deadline: createVaultDeadline(),
        expectedAssetIdentity: walletPlan.assetIdentity,
        plan: walletPlan,
        owner: ownerAddress,
        prepared: {
          plan: walletPlan,
          lookupTables: {},
          blockhash,
          lastValidBlockHeight: 100n,
        },
      })
    ).toThrow("must require only the owner signature");
  });

  it("compiles a caller-provided fee payer into slot zero beside the owner", () => {
    const walletPlan = planForOwner(ownerAddress);
    const unsigned = compileUnsignedVaultTransaction({
      deadline: createVaultDeadline(),
      expectedAssetIdentity: walletPlan.assetIdentity,
      plan: walletPlan,
      owner: ownerAddress,
      feePayer: feePayerAddress,
      prepared: {
        plan: walletPlan,
        lookupTables: {},
        blockhash,
        lastValidBlockHeight: 100n,
      },
    });
    const decoded = getTransactionDecoder().decode(unsigned.bytes);
    // Ordered and exact: kit places the fee payer at static slot zero, and the
    // submit's recorded signature (= the on-chain txid) reads that slot.
    expect(Object.keys(decoded.signatures)).toEqual([feePayerAddress, ownerAddress]);
    expect(Object.values(decoded.signatures)).toEqual([null, null]);
  });

  it("still refuses a smuggled third signer when a fee payer is requested", async () => {
    const extraSigner = await generateKeyPairSigner();
    const walletPlan: EarnVaultTransactionPlan = {
      ...plan,
      instructions: [
        {
          programAddress: "11111111111111111111111111111111",
          accounts: [
            { address: ownerAddress, role: AccountRole.READONLY_SIGNER },
            { address: extraSigner.address, role: AccountRole.READONLY_SIGNER },
          ],
          data: "",
        },
      ],
    };

    expect(() =>
      compileUnsignedVaultTransaction({
        deadline: createVaultDeadline(),
        expectedAssetIdentity: walletPlan.assetIdentity,
        plan: walletPlan,
        owner: ownerAddress,
        feePayer: feePayerAddress,
        prepared: {
          plan: walletPlan,
          lookupTables: {},
          blockhash,
          lastValidBlockHeight: 100n,
        },
      })
    ).toThrow("must require exactly the fee-payer and owner signatures");
  });

  it("treats a fee payer equal to the owner as absent", () => {
    const walletPlan = planForOwner(ownerAddress);
    // Solana deduplicates account keys, so owner-as-fee-payer compiles to ONE
    // signer slot; the compile normalizes rather than tripping its own
    // two-slot assertion on a legitimate build.
    const unsigned = compileUnsignedVaultTransaction({
      deadline: createVaultDeadline(),
      expectedAssetIdentity: walletPlan.assetIdentity,
      plan: walletPlan,
      owner: ownerAddress,
      feePayer: ownerAddress,
      prepared: {
        plan: walletPlan,
        lookupTables: {},
        blockhash,
        lastValidBlockHeight: 100n,
      },
    });
    const decoded = getTransactionDecoder().decode(unsigned.bytes);
    expect(Object.keys(decoded.signatures)).toEqual([ownerAddress]);
  });

  it("classifies an oversized simulation locally before calling RPC", async () => {
    const oversizedPlan: EarnVaultTransactionPlan = {
      ...planForOwner(ownerAddress),
      instructions: [
        {
          programAddress: "11111111111111111111111111111111",
          accounts: [{ address: ownerAddress, role: AccountRole.READONLY_SIGNER }],
          data: Buffer.alloc(1_300).toString("base64"),
        },
      ],
    };

    await expect(
      simulateVaultPlan({
        deadline: createVaultDeadline(),
        expectedAssetIdentity: oversizedPlan.assetIdentity,
        plan: oversizedPlan,
        owner: ownerAddress,
        fee: { kind: "caller-provided", feePayer: feePayerAddress },
      })
    ).rejects.toBeInstanceOf(VaultTransactionTooLargeError);
    expect(simulateSend).not.toHaveBeenCalled();
  });

  it("blocks simulation and broadcast on wrong genesis", async () => {
    const methods = useRealPoolWithDevnetGenesis(GENESIS_HASH_BY_CLUSTER["mainnet-beta"]);
    const _owner = createNoopSigner(ownerAddress);

    await expect(
      simulateVaultPlan({
        deadline: createVaultDeadline(),
        expectedAssetIdentity: plan.assetIdentity,
        plan,
        owner: ownerAddress,
        fee: { kind: "wallet-pays" },
      })
    ).rejects.toMatchObject({ code: "RPC_UNAVAILABLE", reason: "cluster_mismatch" });
    await expect(
      broadcastVaultTransaction({
        deadline: createVaultDeadline(),
        bytes: new Uint8Array(),
      })
    ).rejects.toMatchObject({ code: "RPC_UNAVAILABLE", reason: "cluster_mismatch" });

    // The first path probed and cached the mismatch for the cooldown; nothing else left SDP.
    expect(methods).toEqual(["getGenesisHash"]);
    expect(simulateSend).not.toHaveBeenCalled();
  });

  it("rejects a provider plan that disagrees with the environment-derived cluster", async () => {
    const mainnetPlan = { ...plan, cluster: "mainnet-beta" } as const;

    await expect(
      simulateVaultPlan({
        deadline: createVaultDeadline(),
        expectedAssetIdentity: plan.assetIdentity,
        plan: mainnetPlan,
        owner: ownerAddress,
        fee: { kind: "wallet-pays" },
      })
    ).rejects.toThrow("Vault plan targets mainnet-beta, not the expected devnet cluster");

    expect(factory.createClusterRpc).not.toHaveBeenCalled();
  });

  it("rejects stale or poisoned asset identity before simulation or signing", async () => {
    const expectedAssetIdentity = {
      ...plan.assetIdentity,
      shareMint: "11111111111111111111111111111112",
    };

    await expect(
      simulateVaultPlan({
        deadline: createVaultDeadline(),
        expectedAssetIdentity,
        plan,
        owner: ownerAddress,
        fee: { kind: "wallet-pays" },
      })
    ).rejects.toThrow(/share mint.*does not match/);

    expect(factory.createClusterRpc).not.toHaveBeenCalled();
    expect(solanaRpc.getRecentBlockhash).not.toHaveBeenCalled();
  });

  /**
   * The reason sponsorship needed a single resolved value rather than three
   * decisions. Simulation enforces that the fee payer can PAY, so simulating a
   * sponsored transaction as its own zero-SOL owner is rejected with
   * `AccountNotFound` and no logs, before signing is ever reached.
   */
  it("simulates a sponsored plan as the sponsor, not the owner", async () => {
    const sponsor = address("4YhMUz8xDgHMPAevvfMpnJX9TJmw9DTNDA1sNWPRZG9q");

    const sponsored = await simulateVaultPlan({
      deadline: createVaultDeadline(),
      expectedAssetIdentity: plan.assetIdentity,
      plan,
      owner: ownerAddress,
      fee: { kind: "sponsored", feePayment: feePayment(), sponsor },
    });
    expect(sponsored.ok).toBe(true);
    expect(feePayerOf(simulatedWire.at(-1) ?? "")).toBe(sponsor);

    const walletPays = await simulateVaultPlan({
      deadline: createVaultDeadline(),
      expectedAssetIdentity: plan.assetIdentity,
      plan,
      owner: ownerAddress,
      fee: { kind: "wallet-pays" },
    });
    expect(walletPays.ok).toBe(true);
    expect(feePayerOf(simulatedWire.at(-1) ?? "")).toBe(ownerAddress);
  });

  it("simulates a caller-provided plan as the named fee payer", async () => {
    const result = await simulateVaultPlan({
      deadline: createVaultDeadline(),
      expectedAssetIdentity: plan.assetIdentity,
      plan,
      owner: ownerAddress,
      fee: { kind: "caller-provided", feePayer: feePayerAddress },
    });
    expect(result.ok).toBe(true);
    // The funds check moves to the partner wallet — the whole point for
    // zero-SOL owners — and the simulated message matches the compiled one.
    expect(feePayerOf(simulatedWire.at(-1) ?? "")).toBe(feePayerAddress);
  });

  it("names the caller-provided fee payer in a fee simulation failure", async () => {
    simulateSend.mockResolvedValueOnce({ value: { err: "AccountNotFound", logs: [] } });

    const result = await simulateVaultPlan({
      deadline: createVaultDeadline(),
      expectedAssetIdentity: plan.assetIdentity,
      plan,
      owner: ownerAddress,
      fee: { kind: "caller-provided", feePayer: feePayerAddress },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failed simulation");
    expect(result.error).toContain(`the provided fee payer (${feePayerAddress}) holds no SOL`);
    expect(result.fault).toBe("caller");
  });

  it("translates a fee-payer simulation failure into a readable verdict", async () => {
    simulateSend.mockResolvedValueOnce({ value: { err: "AccountNotFound", logs: [] } });

    const result = await simulateVaultPlan({
      deadline: createVaultDeadline(),
      expectedAssetIdentity: plan.assetIdentity,
      plan,
      owner: ownerAddress,
      fee: { kind: "wallet-pays" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failed simulation");
    expect(result.error).toContain("the wallet holds no SOL");
    // The chain's variant rides beside the prose for operators, never inside it.
    expect(result.error).not.toContain("AccountNotFound");
    expect(result.raw).toBe('"AccountNotFound"');
    expect(result.fault).toBe("caller");
  });

  it("marks a sponsored fee-payer failure as SDP's fault", async () => {
    simulateSend.mockResolvedValueOnce({ value: { err: "AccountNotFound", logs: [] } });

    const result = await simulateVaultPlan({
      deadline: createVaultDeadline(),
      expectedAssetIdentity: plan.assetIdentity,
      plan,
      owner: ownerAddress,
      fee: { kind: "sponsored", feePayment: feePayment(), sponsor: feePayerAddress },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failed simulation");
    expect(result.error).toContain("SDP's fee sponsor holds no SOL");
    expect(result.fault).toBe("sponsor");
  });
});

describe("vault lookup-table reads", () => {
  const lookupTable = "11111111111111111111111111111113";
  const planWithLookupTable: EarnVaultTransactionPlan = {
    ...plan,
    lookupTables: [lookupTable],
    instructions: [
      {
        programAddress: "11111111111111111111111111111111",
        accounts: [{ address: plan.assetIdentity.depositTokenMint, role: AccountRole.READONLY }],
        data: "",
      },
    ],
  };

  function simulate() {
    return simulateVaultPlan({
      deadline: createVaultDeadline(),
      expectedAssetIdentity: plan.assetIdentity,
      plan: planWithLookupTable,
      owner: ownerAddress,
      fee: { kind: "wallet-pays" },
    });
  }

  it("rethrows an exhausted transport failure without simulating an unprepared plan", async () => {
    vi.useFakeTimers();
    const failure = rpcHttpError(503);
    lookupTableSend.mockRejectedValue(failure);

    // A missing RPC mock method used to satisfy a truthy-rejection assertion.
    // Require the exact transport error and real retries, not just any throw.
    const rejection = expect(simulate()).rejects.toBe(failure);
    await Promise.all([rejection, vi.runAllTimersAsync()]);

    expect(lookupTableSend).toHaveBeenCalledTimes(4);
    expect(simulateSend).not.toHaveBeenCalled();
  });

  it("does not retry a permanent lookup-table read failure", async () => {
    const failure = new Error("Invalid params: invalid account address");
    lookupTableSend.mockRejectedValue(failure);

    await expect(simulate()).rejects.toBe(failure);

    expect(lookupTableSend).toHaveBeenCalledOnce();
    expect(simulateSend).not.toHaveBeenCalled();
  });

  it("recovers a transient read and uses the fetched table in the simulated transaction", async () => {
    vi.useFakeTimers();
    lookupTableSend.mockRejectedValueOnce(fetchFailedError()).mockResolvedValue({
      context: { slot: 1n },
      value: [
        {
          owner: "AddressLookupTab1e1111111111111111111111111",
          executable: false,
          lamports: 1n,
          data: {
            program: "address-lookup-table",
            parsed: {
              type: "lookupTable",
              info: { addresses: [plan.assetIdentity.depositTokenMint] },
            },
            space: 88n,
          },
        },
      ],
    });

    const result = expect(simulate()).resolves.toMatchObject({
      ok: true,
      prepared: { lookupTables: { [lookupTable]: [plan.assetIdentity.depositTokenMint] } },
    });
    await Promise.all([result, vi.runAllTimersAsync()]);

    expect(rpc.getMultipleAccounts).toHaveBeenCalledWith([lookupTable], {
      encoding: "jsonParsed",
    });
    expect(lookupTableSend).toHaveBeenCalledTimes(2);
    expect(simulateSend).toHaveBeenCalledOnce();

    const transaction = getTransactionDecoder().decode(
      Buffer.from(simulatedWire.at(-1) ?? "", "base64")
    );
    const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    if (message.version !== 0) throw new Error("expected a v0 simulation transaction");
    expect(message.addressTableLookups).toEqual([
      { lookupTableAddress: lookupTable, readonlyIndexes: [0], writableIndexes: [] },
    ]);
    expect(message.staticAccounts).not.toContain(plan.assetIdentity.depositTokenMint);
    // The instruction must reference the loaded address, after all static accounts.
    expect(message.instructions[0]?.accountIndices).toEqual([message.staticAccounts.length]);
  });
});

describe("strategy execution preparation", () => {
  it("reuses simulation preparation for the exact unsigned message without another RPC read", async () => {
    const simulation = await simulateVaultPlan({
      deadline: createVaultDeadline(),
      expectedAssetIdentity: plan.assetIdentity,
      plan,
      owner: ownerAddress,
      fee: { kind: "wallet-pays" },
    });
    if (!simulation.ok) throw new Error("expected simulation to succeed");
    compileUnsignedVaultTransaction({
      deadline: createVaultDeadline(),
      expectedAssetIdentity: plan.assetIdentity,
      plan,
      owner: ownerAddress,
      prepared: simulation.prepared,
    });
    expect(factory.createClusterRpc).toHaveBeenCalledTimes(1);
    expect(solanaRpc.getRecentBlockhash).toHaveBeenCalledTimes(1);
  });
});

describe("vault execution deadline", () => {
  it("bounds blockhash work with the stage-labelled deadline", async () => {
    vi.useFakeTimers();
    vi.mocked(solanaRpc.getRecentBlockhash).mockReturnValue(new Promise(() => undefined));
    const result = simulateVaultPlan({
      deadline: createVaultDeadline(25),
      expectedAssetIdentity: plan.assetIdentity,
      plan,
      owner: ownerAddress,
      fee: { kind: "wallet-pays" },
    });
    const rejection = expect(result).rejects.toThrow(
      "Fetching the vault simulation blockhash timed out after 25ms"
    );

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
  });

  it("bounds broadcast with the same stage-labelled deadline", async () => {
    vi.useFakeTimers();
    vi.mocked(solanaRpc.sendTransaction).mockReturnValue(new Promise(() => undefined));
    const result = broadcastVaultTransaction({
      deadline: createVaultDeadline(25),
      bytes: new Uint8Array([1, 2, 3]),
    });
    const rejection = expect(result).rejects.toThrow(
      "Broadcasting the vault transaction timed out after 25ms"
    );

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
  });
});
