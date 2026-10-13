import type { EarnVaultTransactionPlan } from "@sdp/earn/types";
import { runInClusterScope } from "@sdp/rpc/scope";
import * as solanaRpc from "@sdp/rpc/solana";
import {
  AccountRole,
  type Address,
  address,
  type Blockhash,
  createNoopSigner,
  generateKeyPairSigner,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  isSolanaError,
  partiallySignTransaction,
  type Signature,
  SOLANA_ERROR__JSON_RPC__INVALID_PARAMS,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
} from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { FeePaymentPort } from "@/services/ports";
import { SponsorMessageMismatchError } from "@/services/sponsorship-integrity";
import {
  type ClusterRpcReply,
  installClusterRpcResponder,
  type JsonRpcResult,
} from "@/test/helpers/cluster-rpc";
import { createVaultDeadline } from "./vault-deadline";
import {
  broadcastVaultTransaction,
  compileUnsignedVaultTransaction,
  signVaultPlan,
  simulateVaultPlan,
  VaultTransactionTooLargeError,
} from "./vault-execution.service";

const SANDBOX_SCOPE = { projectId: "proj_vault_execution", environment: "sandbox" } as const;
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

const stub = installClusterRpcResponder();
const simulatedWire: string[] = [];

function inSandbox<TResult>(work: () => TResult): TResult {
  return runInClusterScope(SANDBOX_SCOPE, work);
}

function answerSimulation(err: JsonRpcResult): void {
  stub.respond("simulateTransaction", (request) => {
    simulatedWire.push(z.string().parse(request.params[0]));
    return { result: { context: { slot: 1 }, value: { err, logs: [] } } };
  });
}

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
    signAndSend: vi.fn().mockResolvedValue(signature),
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
  answerSimulation(null);
  vi.spyOn(solanaRpc, "getRecentBlockhash").mockResolvedValue({
    blockhash,
    lastValidBlockHeight: 100n,
  });
  vi.spyOn(solanaRpc, "sendTransaction").mockResolvedValue(signature);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("vault execution validation", () => {
  it("refuses caller-signed transactions that require any signer besides the owner", async () => {
    const extraSigner = await generateKeyPairSigner();
    const externalPlan: EarnVaultTransactionPlan = {
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
      inSandbox(() =>
        compileUnsignedVaultTransaction({
          deadline: createVaultDeadline(),
          expectedAssetIdentity: externalPlan.assetIdentity,
          plan: externalPlan,
          owner: ownerAddress,
          prepared: {
            plan: externalPlan,
            lookupTables: {},
            blockhash,
            lastValidBlockHeight: 100n,
          },
        })
      )
    ).toThrow("must require only the owner signature");
  });

  it("compiles a caller-provided fee payer into slot zero beside the owner", () => {
    const externalPlan = planForOwner(ownerAddress);
    const unsigned = inSandbox(() =>
      compileUnsignedVaultTransaction({
        deadline: createVaultDeadline(),
        expectedAssetIdentity: externalPlan.assetIdentity,
        plan: externalPlan,
        owner: ownerAddress,
        feePayer: feePayerAddress,
        prepared: {
          plan: externalPlan,
          lookupTables: {},
          blockhash,
          lastValidBlockHeight: 100n,
        },
      })
    );
    const decoded = getTransactionDecoder().decode(unsigned.bytes);
    // Ordered and exact: kit places the fee payer at static slot zero, and the
    // submit's recorded signature (= the on-chain txid) reads that slot.
    expect(Object.keys(decoded.signatures)).toEqual([feePayerAddress, ownerAddress]);
    expect(Object.values(decoded.signatures)).toEqual([null, null]);
  });

  it("still refuses a smuggled third signer when a fee payer is requested", async () => {
    const extraSigner = await generateKeyPairSigner();
    const externalPlan: EarnVaultTransactionPlan = {
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
      inSandbox(() =>
        compileUnsignedVaultTransaction({
          deadline: createVaultDeadline(),
          expectedAssetIdentity: externalPlan.assetIdentity,
          plan: externalPlan,
          owner: ownerAddress,
          feePayer: feePayerAddress,
          prepared: {
            plan: externalPlan,
            lookupTables: {},
            blockhash,
            lastValidBlockHeight: 100n,
          },
        })
      )
    ).toThrow("must require exactly the fee-payer and owner signatures");
  });

  it("treats a fee payer equal to the owner as absent", () => {
    const externalPlan = planForOwner(ownerAddress);
    // Solana deduplicates account keys, so owner-as-fee-payer compiles to ONE
    // signer slot; the compile normalizes rather than tripping its own
    // two-slot assertion on a legitimate build.
    const unsigned = inSandbox(() =>
      compileUnsignedVaultTransaction({
        deadline: createVaultDeadline(),
        expectedAssetIdentity: externalPlan.assetIdentity,
        plan: externalPlan,
        owner: ownerAddress,
        feePayer: ownerAddress,
        prepared: {
          plan: externalPlan,
          lookupTables: {},
          blockhash,
          lastValidBlockHeight: 100n,
        },
      })
    );
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
      inSandbox(() =>
        simulateVaultPlan({
          deadline: createVaultDeadline(),
          expectedAssetIdentity: oversizedPlan.assetIdentity,
          plan: oversizedPlan,
          owner: ownerAddress,
          fee: { kind: "caller-provided", feePayer: feePayerAddress },
        })
      )
    ).rejects.toBeInstanceOf(VaultTransactionTooLargeError);
    expect(simulatedWire).toEqual([]);
  });

  it("refuses to sign a caller-provided fee mode", async () => {
    await expect(
      inSandbox(() =>
        signVaultPlan({
          deadline: createVaultDeadline(),
          expectedAssetIdentity: plan.assetIdentity,
          plan,
          owner: createNoopSigner(ownerAddress),
          fee: { kind: "caller-provided", feePayer: feePayerAddress },
        })
      )
    ).rejects.toThrow("compile the transaction unsigned");
  });

  it("rejects a provider plan that disagrees with the environment-derived cluster", async () => {
    const mainnetPlan = { ...plan, cluster: "mainnet-beta" } as const;

    await expect(
      inSandbox(() =>
        signVaultPlan({
          deadline: createVaultDeadline(),
          expectedAssetIdentity: plan.assetIdentity,
          plan: mainnetPlan,
          owner: createNoopSigner(ownerAddress),
          fee: { kind: "wallet-pays" },
        })
      )
    ).rejects.toThrow("Vault plan targets mainnet-beta, not the expected devnet cluster");

    expect(stub.calls).toEqual([]);
  });

  it("rejects stale or poisoned asset identity before simulation or signing", async () => {
    const expectedAssetIdentity = {
      ...plan.assetIdentity,
      shareMint: "11111111111111111111111111111112",
    };

    await expect(
      inSandbox(() =>
        signVaultPlan({
          deadline: createVaultDeadline(),
          expectedAssetIdentity,
          plan,
          owner: createNoopSigner(ownerAddress),
          fee: { kind: "wallet-pays" },
        })
      )
    ).rejects.toThrow(/share mint.*does not match/);
    await expect(
      inSandbox(() =>
        simulateVaultPlan({
          deadline: createVaultDeadline(),
          expectedAssetIdentity,
          plan,
          owner: ownerAddress,
          fee: { kind: "wallet-pays" },
        })
      )
    ).rejects.toThrow(/share mint.*does not match/);

    expect(stub.calls).toEqual([]);
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

    const sponsored = await inSandbox(() =>
      simulateVaultPlan({
        deadline: createVaultDeadline(),
        expectedAssetIdentity: plan.assetIdentity,
        plan,
        owner: ownerAddress,
        fee: { kind: "sponsored", feePayment: feePayment(), sponsor },
      })
    );
    expect(sponsored.ok).toBe(true);
    expect(feePayerOf(simulatedWire.at(-1) ?? "")).toBe(sponsor);

    const walletPays = await inSandbox(() =>
      simulateVaultPlan({
        deadline: createVaultDeadline(),
        expectedAssetIdentity: plan.assetIdentity,
        plan,
        owner: ownerAddress,
        fee: { kind: "wallet-pays" },
      })
    );
    expect(walletPays.ok).toBe(true);
    expect(feePayerOf(simulatedWire.at(-1) ?? "")).toBe(ownerAddress);
  });

  it("simulates a caller-provided plan as the named fee payer", async () => {
    const result = await inSandbox(() =>
      simulateVaultPlan({
        deadline: createVaultDeadline(),
        expectedAssetIdentity: plan.assetIdentity,
        plan,
        owner: ownerAddress,
        fee: { kind: "caller-provided", feePayer: feePayerAddress },
      })
    );
    expect(result.ok).toBe(true);
    // The funds check moves to the partner wallet — the whole point for
    // zero-SOL owners — and the simulated message matches the compiled one.
    expect(feePayerOf(simulatedWire.at(-1) ?? "")).toBe(feePayerAddress);
  });

  it("names the caller-provided fee payer in a fee simulation failure", async () => {
    answerSimulation("AccountNotFound");

    const result = await inSandbox(() =>
      simulateVaultPlan({
        deadline: createVaultDeadline(),
        expectedAssetIdentity: plan.assetIdentity,
        plan,
        owner: ownerAddress,
        fee: { kind: "caller-provided", feePayer: feePayerAddress },
      })
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failed simulation");
    expect(result.error).toContain(`the provided fee payer (${feePayerAddress}) holds no SOL`);
    expect(result.fault).toBe("caller");
  });

  it("translates a fee-payer simulation failure into a readable verdict", async () => {
    answerSimulation("AccountNotFound");

    const result = await inSandbox(() =>
      simulateVaultPlan({
        deadline: createVaultDeadline(),
        expectedAssetIdentity: plan.assetIdentity,
        plan,
        owner: ownerAddress,
        fee: { kind: "wallet-pays" },
      })
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failed simulation");
    expect(result.error).toContain("the wallet holds no SOL");
    // The chain's variant rides beside the prose for operators, never inside it.
    expect(result.error).not.toContain("AccountNotFound");
    expect(result.raw).toBe('"AccountNotFound"');
    expect(result.fault).toBe("caller");
  });

  it("marks a sponsored fee-payer failure as SDP's fault", async () => {
    answerSimulation("AccountNotFound");

    const result = await inSandbox(() =>
      simulateVaultPlan({
        deadline: createVaultDeadline(),
        expectedAssetIdentity: plan.assetIdentity,
        plan,
        owner: ownerAddress,
        fee: { kind: "sponsored", feePayment: feePayment(), sponsor: feePayerAddress },
      })
    );

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
    return inSandbox(() =>
      simulateVaultPlan({
        deadline: createVaultDeadline(),
        expectedAssetIdentity: plan.assetIdentity,
        plan: planWithLookupTable,
        owner: ownerAddress,
        fee: { kind: "wallet-pays" },
      })
    );
  }

  function lookupTableReads() {
    return stub.requests.filter((request) => request.method === "getMultipleAccounts");
  }

  function answerLookupTableReads(replies: readonly ClusterRpcReply[]): void {
    stub.respond(
      "getMultipleAccounts",
      () => replies[Math.min(lookupTableReads().length, replies.length) - 1]
    );
  }

  const nodeUnhealthy: ClusterRpcReply = {
    error: {
      code: SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
      message: "Node is unhealthy",
    },
  };

  it("rethrows an exhausted transport failure without simulating an unprepared plan", async () => {
    answerLookupTableReads([nodeUnhealthy]);

    await expect(simulate()).rejects.toSatisfy((error) =>
      isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY)
    );

    expect(lookupTableReads()).toHaveLength(4);
    expect(simulatedWire).toEqual([]);
  });

  it("does not retry a permanent lookup-table read failure", async () => {
    answerLookupTableReads([
      { error: { code: SOLANA_ERROR__JSON_RPC__INVALID_PARAMS, message: "Invalid params" } },
    ]);

    await expect(simulate()).rejects.toSatisfy((error) =>
      isSolanaError(error, SOLANA_ERROR__JSON_RPC__INVALID_PARAMS)
    );

    expect(lookupTableReads()).toHaveLength(1);
    expect(simulatedWire).toEqual([]);
  });

  it("recovers a transient read and uses the fetched table in the simulated transaction", async () => {
    answerLookupTableReads([
      nodeUnhealthy,
      {
        result: {
          context: { slot: 1 },
          value: [
            {
              owner: "AddressLookupTab1e1111111111111111111111111",
              executable: false,
              lamports: 1,
              data: {
                program: "address-lookup-table",
                parsed: {
                  type: "lookupTable",
                  info: { addresses: [plan.assetIdentity.depositTokenMint] },
                },
                space: 88,
              },
            },
          ],
        },
      },
    ]);

    await expect(simulate()).resolves.toMatchObject({
      ok: true,
      prepared: { lookupTables: { [lookupTable]: [plan.assetIdentity.depositTokenMint] } },
    });

    expect(lookupTableReads().map((request) => request.params)).toEqual([
      [[lookupTable], { encoding: "jsonParsed" }],
      [[lookupTable], { encoding: "jsonParsed" }],
    ]);
    expect(simulatedWire).toHaveLength(1);

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

describe("vault signing lifecycle", () => {
  it("reuses successful simulation preparation for signing", async () => {
    const owner = await generateKeyPairSigner();
    const simulation = await inSandbox(() =>
      simulateVaultPlan({
        deadline: createVaultDeadline(),
        expectedAssetIdentity: plan.assetIdentity,
        plan,
        owner: owner.address,
        fee: { kind: "wallet-pays" },
      })
    );
    if (!simulation.ok) throw new Error("expected simulation to succeed");

    await inSandbox(() =>
      signVaultPlan({
        deadline: createVaultDeadline(),
        expectedAssetIdentity: plan.assetIdentity,
        plan,
        owner,
        fee: { kind: "wallet-pays" },
        prepared: simulation.prepared,
      })
    );

    expect(solanaRpc.getRecentBlockhash).toHaveBeenCalledTimes(1);
  });

  it("rejects a signed transaction above Solana's byte limit", async () => {
    const owner = await generateKeyPairSigner();
    const oversizedPlan: EarnVaultTransactionPlan = {
      ...plan,
      instructions: [
        {
          programAddress: "11111111111111111111111111111111",
          accounts: [{ address: owner.address, role: AccountRole.READONLY_SIGNER }],
          data: Buffer.alloc(1_500).toString("base64"),
        },
      ],
    };

    await expect(
      inSandbox(() =>
        signVaultPlan({
          deadline: createVaultDeadline(),
          expectedAssetIdentity: plan.assetIdentity,
          plan: oversizedPlan,
          owner,
          fee: { kind: "wallet-pays" },
        })
      )
    ).rejects.toThrow("Solana allows at most 1232");
  });

  it("fully signs a sponsored transaction without sending it", async () => {
    const owner = await generateKeyPairSigner();
    const sponsor = await generateKeyPairSigner();
    const signAndSend = vi.fn();
    const signAsFeePayer = vi.fn(async (ownerSignedBytes: Uint8Array) => {
      const ownerSigned = getTransactionDecoder().decode(ownerSignedBytes);
      expect(ownerSigned.signatures[owner.address]).not.toBeNull();
      expect(ownerSigned.signatures[sponsor.address]).toBeNull();
      const fullySigned = await partiallySignTransaction([sponsor.keyPair], ownerSigned);
      return new Uint8Array(getTransactionEncoder().encode(fullySigned));
    });
    const fee = feePayment({
      getFeePayer: vi.fn().mockResolvedValue(sponsor.address),
      signAsFeePayer,
      signAndSend,
    });

    const result = await inSandbox(() =>
      signVaultPlan({
        deadline: createVaultDeadline(),
        expectedAssetIdentity: plan.assetIdentity,
        plan: planForOwner(owner.address),
        owner,
        fee: { kind: "sponsored", feePayment: fee, sponsor: sponsor.address },
      })
    );

    const decoded = getTransactionDecoder().decode(result.bytes);
    expect(decoded.signatures[owner.address]).not.toBeNull();
    expect(decoded.signatures[sponsor.address]).not.toBeNull();
    expect(result.signature).toBe(getSignatureFromTransaction(decoded));
    expect(signAsFeePayer).toHaveBeenCalledOnce();
    expect(signAndSend).not.toHaveBeenCalled();
    expect(solanaRpc.sendTransaction).not.toHaveBeenCalled();
  });

  it("surfaces the port's sponsor-response refusal without broadcasting", async () => {
    const owner = await generateKeyPairSigner();
    const sponsor = await generateKeyPairSigner();
    const refusal = new SponsorMessageMismatchError();
    const signAsFeePayer = vi.fn().mockRejectedValue(refusal);
    const fee = feePayment({
      getFeePayer: vi.fn().mockResolvedValue(sponsor.address),
      signAsFeePayer,
      signAndSend: vi.fn(),
    });

    await expect(
      inSandbox(() =>
        signVaultPlan({
          deadline: createVaultDeadline(),
          expectedAssetIdentity: plan.assetIdentity,
          plan: planForOwner(owner.address),
          owner,
          fee: { kind: "sponsored", feePayment: fee, sponsor: sponsor.address },
        })
      )
    ).rejects.toBe(refusal);

    expect(solanaRpc.sendTransaction).not.toHaveBeenCalled();
  });

  it("signs wallet-paid bytes without broadcasting before durable persistence", async () => {
    const owner = await generateKeyPairSigner();

    const result = await inSandbox(() =>
      signVaultPlan({
        deadline: createVaultDeadline(),
        expectedAssetIdentity: plan.assetIdentity,
        plan: planForOwner(owner.address),
        owner,
        fee: { kind: "wallet-pays" },
      })
    );

    const decoded = getTransactionDecoder().decode(result.bytes);
    expect(decoded.signatures[owner.address]).not.toBeNull();
    expect(result.signature).toBe(getSignatureFromTransaction(decoded));
    expect(solanaRpc.sendTransaction).not.toHaveBeenCalled();
  });
});

describe("vault execution deadline", () => {
  it("bounds blockhash work with the stage-labelled deadline", async () => {
    vi.useFakeTimers();
    vi.mocked(solanaRpc.getRecentBlockhash).mockReturnValue(new Promise(() => undefined));
    const result = inSandbox(() =>
      signVaultPlan({
        deadline: createVaultDeadline(25),
        expectedAssetIdentity: plan.assetIdentity,
        plan,
        owner: createNoopSigner(ownerAddress),
        fee: { kind: "wallet-pays" },
      })
    );
    const rejection = expect(result).rejects.toThrow(
      "Fetching the vault transaction blockhash timed out after 25ms"
    );

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
  });

  it("signs with the sponsor it was given and never re-reads it", async () => {
    // The sponsor address travelled into the provider's instructions as the rent
    // payer before this point, so the instructions already commit to it.
    // Re-reading it here could name a DIFFERENT address than they name, which is
    // why signing must not ask the paymaster who it is.
    const owner = await generateKeyPairSigner();
    const sponsor = await generateKeyPairSigner();
    const getFeePayer = vi.fn<() => Promise<Address>>();
    const signAsFeePayer = vi.fn(async (ownerSignedBytes: Uint8Array) => {
      const ownerSigned = getTransactionDecoder().decode(ownerSignedBytes);
      const fullySigned = await partiallySignTransaction([sponsor.keyPair], ownerSigned);
      return new Uint8Array(getTransactionEncoder().encode(fullySigned));
    });

    const result = await inSandbox(() =>
      signVaultPlan({
        deadline: createVaultDeadline(),
        expectedAssetIdentity: plan.assetIdentity,
        plan: planForOwner(owner.address),
        owner,
        fee: {
          kind: "sponsored",
          feePayment: feePayment({ getFeePayer, signAsFeePayer }),
          sponsor: sponsor.address,
        },
      })
    );

    expect(getFeePayer).not.toHaveBeenCalled();
    const decoded = getTransactionDecoder().decode(result.bytes);
    expect(decoded.signatures[sponsor.address]).not.toBeNull();
    expect(decoded.signatures[owner.address]).not.toBeNull();
  });

  it("bounds broadcast with the same stage-labelled deadline", async () => {
    vi.useFakeTimers();
    vi.mocked(solanaRpc.sendTransaction).mockReturnValue(new Promise(() => undefined));
    const result = inSandbox(() =>
      broadcastVaultTransaction({
        deadline: createVaultDeadline(25),
        bytes: new Uint8Array([1, 2, 3]),
      })
    );
    const rejection = expect(result).rejects.toThrow(
      "Broadcasting the vault transaction timed out after 25ms"
    );

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
  });
});
