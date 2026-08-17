import type { EarnVaultTransactionPlan } from "@sdp/earn/types";
import * as solanaRpc from "@sdp/rpc/solana";
import { GENESIS_HASH_BY_CLUSTER } from "@sdp/types";
import {
  type Address,
  address,
  type Blockhash,
  createNoopSigner,
  type Signature,
} from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeePaymentPort } from "@/services/ports";
import type { Env } from "@/types/env";
import { resetClusterEndpointProofs } from "./execution-registry";
import { createVaultDeadline } from "./vault-deadline";
import {
  broadcastVaultTransaction,
  signVaultPlan,
  simulateVaultPlan,
  submitVaultPlan,
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
  transactions: [
    [
      {
        programAddress: "11111111111111111111111111111111",
        accounts: [],
        data: "",
      },
    ],
  ],
  lookupTables: [],
  assetIdentity: {
    depositTokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    shareMint: "So11111111111111111111111111111111111111112",
  },
};

const genesisSend = vi.fn();
const simulateSend = vi.fn();
const rpc = {
  getGenesisHash: () => ({ send: genesisSend }),
  simulateTransaction: () => ({ send: simulateSend }),
};

function feePayment(overrides: Partial<FeePaymentPort> = {}): FeePaymentPort {
  return {
    providerId: "test",
    getFeePayer: vi.fn().mockResolvedValue(feePayerAddress),
    signAsFeePayer: vi.fn(),
    signAndSend: vi.fn().mockResolvedValue(signature),
    ...overrides,
  } as FeePaymentPort;
}

beforeEach(() => {
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

describe("vault execution cluster proof", () => {
  it("blocks every raw execution path before RPC, signing, or fee payment on wrong genesis", async () => {
    genesisSend.mockResolvedValue(GENESIS_HASH_BY_CLUSTER["mainnet-beta"]);
    const sponsor = feePayment();
    const owner = createNoopSigner(ownerAddress);

    await expect(
      signVaultPlan(env, {
        cluster: "devnet",
        deadline: createVaultDeadline(),
        plan,
        owner,
        rpcUrl,
      })
    ).rejects.toThrow(/reports genesis/);
    await expect(
      simulateVaultPlan(env, {
        cluster: "devnet",
        deadline: createVaultDeadline(),
        plan,
        owner: ownerAddress,
        rpcUrl,
      })
    ).rejects.toThrow(/reports genesis/);
    await expect(
      submitVaultPlan(env, {
        cluster: "devnet",
        deadline: createVaultDeadline(),
        plan,
        owner,
        rpcUrl,
        fee: { kind: "sponsored", feePayment: sponsor },
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
    expect(sponsor.getFeePayer).not.toHaveBeenCalled();
    expect(sponsor.signAndSend).not.toHaveBeenCalled();
  });

  it("rejects a provider plan that disagrees with the environment-derived cluster", async () => {
    const mainnetPlan = { ...plan, cluster: "mainnet-beta" } as const;

    await expect(
      signVaultPlan(env, {
        cluster: "devnet",
        deadline: createVaultDeadline(),
        plan: mainnetPlan,
        owner: createNoopSigner(ownerAddress),
        rpcUrl,
      })
    ).rejects.toThrow("Vault plan targets mainnet-beta, not the expected devnet cluster");

    expect(solanaRpc.createRpc).not.toHaveBeenCalled();
  });
});

describe("vault execution deadline", () => {
  it("shares one absolute budget across blockhash and sponsored fee-payer work", async () => {
    vi.useFakeTimers();
    vi.mocked(solanaRpc.getRecentBlockhash).mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ blockhash, lastValidBlockHeight: 100n }), 15)
        )
    );
    let resolveFeePayer!: (address: Address) => void;
    const getFeePayer = vi.fn<() => Promise<Address>>(
      () =>
        new Promise((resolve) => {
          resolveFeePayer = resolve;
        })
    );
    const signAndSend = vi.fn<(_bytes: Uint8Array) => Promise<Signature>>();
    const sponsor = feePayment({ getFeePayer, signAndSend });
    const result = submitVaultPlan(env, {
      cluster: "devnet",
      deadline: createVaultDeadline(25),
      plan,
      owner: createNoopSigner(ownerAddress),
      rpcUrl,
      fee: { kind: "sponsored", feePayment: sponsor },
    });
    const rejection = expect(result).rejects.toThrow(
      "Resolving the sponsored fee payer timed out after 25ms"
    );

    await vi.advanceTimersByTimeAsync(15);
    expect(getFeePayer).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10);
    await rejection;

    resolveFeePayer(feePayerAddress);
    await Promise.resolve();
    expect(signAndSend).not.toHaveBeenCalled();
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
