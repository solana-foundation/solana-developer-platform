import type { EarnVaultTransactionPlan } from "@sdp/earn/types";
import * as solanaRpc from "@sdp/rpc/solana";
import { GENESIS_HASH_BY_CLUSTER } from "@sdp/types";
import {
  AccountRole,
  type Address,
  address,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  pipe,
  type Signature,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeePaymentPort } from "@/services/ports";
import type { Env } from "@/types/env";
import { resetClusterEndpointProofs } from "./execution-registry";
import { createVaultDeadline } from "./vault-deadline";
import {
  broadcastVaultTransaction,
  compileUnsignedVaultTransaction,
  signVaultPlan,
  simulateVaultPlan,
} from "./vault-execution.service";

const env = {} as Env;
const rpcUrl = "https://rpc.example.invalid";
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

const genesisSend = vi.fn();
const simulateSend = vi.fn();
/** Base64 wire transactions handed to `simulateTransaction`, newest last. */
const simulatedWire: string[] = [];
const rpc = {
  getGenesisHash: () => ({ send: genesisSend }),
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
  resetClusterEndpointProofs();
  genesisSend.mockReset().mockResolvedValue(GENESIS_HASH_BY_CLUSTER.devnet);
  simulateSend.mockReset().mockResolvedValue({ value: { err: null, logs: [] } });
  vi.spyOn(solanaRpc, "createRpc").mockReturnValue(rpc as never);
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
      compileUnsignedVaultTransaction({
        cluster: "devnet",
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
    ).toThrow("must require only the owner signature");
  });

  it("blocks every raw execution path before RPC or signing on wrong genesis", async () => {
    genesisSend.mockResolvedValue(GENESIS_HASH_BY_CLUSTER["mainnet-beta"]);
    const owner = createNoopSigner(ownerAddress);

    await expect(
      signVaultPlan(env, {
        cluster: "devnet",
        deadline: createVaultDeadline(),
        expectedAssetIdentity: plan.assetIdentity,
        plan,
        owner,
        rpcUrl,
        fee: { kind: "wallet-pays" },
      })
    ).rejects.toThrow(/reports genesis/);
    await expect(
      simulateVaultPlan(env, {
        cluster: "devnet",
        deadline: createVaultDeadline(),
        expectedAssetIdentity: plan.assetIdentity,
        plan,
        owner: ownerAddress,
        rpcUrl,
        fee: { kind: "wallet-pays" },
      })
    ).rejects.toThrow(/reports genesis/);
    await expect(
      broadcastVaultTransaction(env, {
        cluster: "devnet",
        deadline: createVaultDeadline(),
        bytes: new Uint8Array(),
        rpcUrl,
      })
    ).rejects.toThrow(/reports genesis/);

    expect(solanaRpc.getRecentBlockhash).not.toHaveBeenCalled();
    expect(solanaRpc.sendTransaction).not.toHaveBeenCalled();
    expect(simulateSend).not.toHaveBeenCalled();
  });

  it("rejects a provider plan that disagrees with the environment-derived cluster", async () => {
    const mainnetPlan = { ...plan, cluster: "mainnet-beta" } as const;

    await expect(
      signVaultPlan(env, {
        cluster: "devnet",
        deadline: createVaultDeadline(),
        expectedAssetIdentity: plan.assetIdentity,
        plan: mainnetPlan,
        owner: createNoopSigner(ownerAddress),
        rpcUrl,
        fee: { kind: "wallet-pays" },
      })
    ).rejects.toThrow("Vault plan targets mainnet-beta, not the expected devnet cluster");

    expect(solanaRpc.createRpc).not.toHaveBeenCalled();
  });

  it("rejects stale or poisoned asset identity before simulation or signing", async () => {
    const expectedAssetIdentity = {
      ...plan.assetIdentity,
      shareMint: "11111111111111111111111111111112",
    };

    await expect(
      signVaultPlan(env, {
        cluster: "devnet",
        deadline: createVaultDeadline(),
        expectedAssetIdentity,
        plan,
        owner: createNoopSigner(ownerAddress),
        rpcUrl,
        fee: { kind: "wallet-pays" },
      })
    ).rejects.toThrow(/share mint.*does not match/);
    await expect(
      simulateVaultPlan(env, {
        cluster: "devnet",
        deadline: createVaultDeadline(),
        expectedAssetIdentity,
        plan,
        owner: ownerAddress,
        rpcUrl,
        fee: { kind: "wallet-pays" },
      })
    ).rejects.toThrow(/share mint.*does not match/);

    expect(solanaRpc.createRpc).not.toHaveBeenCalled();
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

    const sponsored = await simulateVaultPlan(env, {
      cluster: "devnet",
      deadline: createVaultDeadline(),
      expectedAssetIdentity: plan.assetIdentity,
      plan,
      owner: ownerAddress,
      rpcUrl,
      fee: { kind: "sponsored", feePayment: feePayment(), sponsor },
    });
    expect(sponsored.ok).toBe(true);
    expect(feePayerOf(simulatedWire.at(-1) ?? "")).toBe(sponsor);

    const walletPays = await simulateVaultPlan(env, {
      cluster: "devnet",
      deadline: createVaultDeadline(),
      expectedAssetIdentity: plan.assetIdentity,
      plan,
      owner: ownerAddress,
      rpcUrl,
      fee: { kind: "wallet-pays" },
    });
    expect(walletPays.ok).toBe(true);
    expect(feePayerOf(simulatedWire.at(-1) ?? "")).toBe(ownerAddress);
  });

  it("translates a fee-payer simulation failure into a readable verdict", async () => {
    simulateSend.mockResolvedValueOnce({ value: { err: "AccountNotFound", logs: [] } });

    const result = await simulateVaultPlan(env, {
      cluster: "devnet",
      deadline: createVaultDeadline(),
      expectedAssetIdentity: plan.assetIdentity,
      plan,
      owner: ownerAddress,
      rpcUrl,
      fee: { kind: "wallet-pays" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failed simulation");
    expect(result.error).toContain("the wallet holds no SOL");
    expect(result.error).toContain("AccountNotFound");
    expect(result.fault).toBe("caller");
  });

  it("marks a sponsored fee-payer failure as SDP's fault", async () => {
    simulateSend.mockResolvedValueOnce({ value: { err: "AccountNotFound", logs: [] } });

    const result = await simulateVaultPlan(env, {
      cluster: "devnet",
      deadline: createVaultDeadline(),
      expectedAssetIdentity: plan.assetIdentity,
      plan,
      owner: ownerAddress,
      rpcUrl,
      fee: { kind: "sponsored", feePayment: feePayment(), sponsor: feePayerAddress },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failed simulation");
    expect(result.error).toContain("SDP's fee sponsor holds no SOL");
    expect(result.fault).toBe("sponsor");
  });

  it("rejects lookup-table transport failures instead of returning a simulation verdict", async () => {
    const planWithLookupTable = {
      ...plan,
      lookupTables: ["11111111111111111111111111111112"],
    };

    await expect(
      simulateVaultPlan(env, {
        cluster: "devnet",
        deadline: createVaultDeadline(),
        expectedAssetIdentity: plan.assetIdentity,
        plan: planWithLookupTable,
        owner: ownerAddress,
        rpcUrl,
        fee: { kind: "wallet-pays" },
      })
    ).rejects.toBeTruthy();
  });
});

describe("vault signing lifecycle", () => {
  it("reuses successful simulation preparation for signing", async () => {
    const owner = await generateKeyPairSigner();
    const simulation = await simulateVaultPlan(env, {
      cluster: "devnet",
      deadline: createVaultDeadline(),
      expectedAssetIdentity: plan.assetIdentity,
      plan,
      owner: owner.address,
      rpcUrl,
      fee: { kind: "wallet-pays" },
    });
    if (!simulation.ok) throw new Error("expected simulation to succeed");

    await signVaultPlan(env, {
      cluster: "devnet",
      deadline: createVaultDeadline(),
      expectedAssetIdentity: plan.assetIdentity,
      plan,
      owner,
      rpcUrl,
      fee: { kind: "wallet-pays" },
      prepared: simulation.prepared,
    });

    expect(genesisSend).toHaveBeenCalledTimes(1);
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
      signVaultPlan(env, {
        cluster: "devnet",
        deadline: createVaultDeadline(),
        expectedAssetIdentity: plan.assetIdentity,
        plan: oversizedPlan,
        owner,
        rpcUrl,
        fee: { kind: "wallet-pays" },
      })
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

    const result = await signVaultPlan(env, {
      cluster: "devnet",
      deadline: createVaultDeadline(),
      expectedAssetIdentity: plan.assetIdentity,
      plan: planForOwner(owner.address),
      owner,
      rpcUrl,
      fee: { kind: "sponsored", feePayment: fee, sponsor: sponsor.address },
    });

    const decoded = getTransactionDecoder().decode(result.bytes);
    expect(decoded.signatures[owner.address]).not.toBeNull();
    expect(decoded.signatures[sponsor.address]).not.toBeNull();
    expect(result.signature).toBe(getSignatureFromTransaction(decoded));
    expect(signAsFeePayer).toHaveBeenCalledOnce();
    expect(signAndSend).not.toHaveBeenCalled();
    expect(solanaRpc.sendTransaction).not.toHaveBeenCalled();
  });

  /**
   * A paymaster hands back BYTES, so nothing about the call constrains it to
   * return the message SDP signed. Both cases below have to fail before
   * persistence: past that point the row is durable, and a sigverify rejection
   * at broadcast is indistinguishable from a lost response, so the movement
   * parks reconcilable until its blockhash expires.
   */
  it("rejects sponsored bytes with an unsigned fee-payer slot", async () => {
    const owner = await generateKeyPairSigner();
    const sponsor = await generateKeyPairSigner();

    await expect(
      signVaultPlan(env, {
        cluster: "devnet",
        deadline: createVaultDeadline(),
        expectedAssetIdentity: plan.assetIdentity,
        plan: planForOwner(owner.address),
        owner,
        rpcUrl,
        // Echoes the bytes back untouched, leaving the sponsor slot null.
        fee: {
          kind: "sponsored",
          feePayment: feePayment(),
          sponsor: sponsor.address,
        },
      })
    ).rejects.toThrow("missing the sponsor fee-payer signature");
  });

  /**
   * The case nothing caught before: the owner slot still carries a signature
   * (over the OLD message) and a SUBSTITUTED fee payer still satisfies
   * `getSignatureFromTransaction`, which reads whatever sits in slot zero.
   * Message equality is the only check that sees it.
   */
  it("rejects sponsored bytes returned over a different message", async () => {
    const owner = await generateKeyPairSigner();
    const sponsor = await generateKeyPairSigner();
    const substitute = await generateKeyPairSigner();
    const signAsFeePayer = vi.fn(async () => {
      const foreign = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(substitute.address, m),
        (m) =>
          setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: 100n }, m),
        (m) =>
          appendTransactionMessageInstructions(
            [{ programAddress: address("11111111111111111111111111111111") }],
            m
          ),
        compileTransaction
      );
      const signed = await partiallySignTransaction([substitute.keyPair], foreign);
      return new Uint8Array(getTransactionEncoder().encode(signed));
    });

    await expect(
      signVaultPlan(env, {
        cluster: "devnet",
        deadline: createVaultDeadline(),
        expectedAssetIdentity: plan.assetIdentity,
        plan: planForOwner(owner.address),
        owner,
        rpcUrl,
        fee: {
          kind: "sponsored",
          feePayment: feePayment({ signAsFeePayer }),
          sponsor: sponsor.address,
        },
      })
    ).rejects.toThrow("came back over a different message");
  });

  it("signs wallet-paid bytes without broadcasting before durable persistence", async () => {
    const owner = await generateKeyPairSigner();

    const result = await signVaultPlan(env, {
      cluster: "devnet",
      deadline: createVaultDeadline(),
      expectedAssetIdentity: plan.assetIdentity,
      plan: planForOwner(owner.address),
      owner,
      rpcUrl,
      fee: { kind: "wallet-pays" },
    });

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
    const result = signVaultPlan(env, {
      cluster: "devnet",
      deadline: createVaultDeadline(25),
      expectedAssetIdentity: plan.assetIdentity,
      plan,
      owner: createNoopSigner(ownerAddress),
      rpcUrl,
      fee: { kind: "wallet-pays" },
    });
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

    const result = await signVaultPlan(env, {
      cluster: "devnet",
      deadline: createVaultDeadline(),
      expectedAssetIdentity: plan.assetIdentity,
      plan: planForOwner(owner.address),
      owner,
      rpcUrl,
      fee: {
        kind: "sponsored",
        feePayment: feePayment({ getFeePayer, signAsFeePayer }),
        sponsor: sponsor.address,
      },
    });

    expect(getFeePayer).not.toHaveBeenCalled();
    const decoded = getTransactionDecoder().decode(result.bytes);
    expect(decoded.signatures[sponsor.address]).not.toBeNull();
    expect(decoded.signatures[owner.address]).not.toBeNull();
  });

  it("bounds broadcast with the same stage-labelled deadline", async () => {
    vi.useFakeTimers();
    vi.mocked(solanaRpc.sendTransaction).mockReturnValue(new Promise(() => undefined));
    const result = broadcastVaultTransaction(env, {
      cluster: "devnet",
      deadline: createVaultDeadline(25),
      bytes: new Uint8Array([1, 2, 3]),
      rpcUrl,
    });
    const rejection = expect(result).rejects.toThrow(
      "Broadcasting the vault transaction timed out after 25ms"
    );

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
  });
});
