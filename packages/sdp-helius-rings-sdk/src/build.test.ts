import { DEFAULT_TREE_ADDRESS } from "@heliuslabs/zolana/interface";
import type { BuildOperationInput } from "@sdp/helius-rings";
import {
  address,
  type Blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase64Codec,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeterministicMaterialSource } from "./deterministic-ka/index.js";
import { TEST_SEED } from "./test/shielded-identity-fixtures.js";

const buildWithdrawal = vi.fn();
const hydrateWallet = vi.fn();
const buildRingWithdrawalTx = vi.fn();
const buildRingTransferTx = vi.fn();

vi.mock("./flows/spend.js", () => ({
  buildWithdrawal: (...args: unknown[]) => buildWithdrawal(...args),
}));

vi.mock("./flows/ring-spend.js", () => ({
  buildRingWithdrawalTx: (...args: unknown[]) => buildRingWithdrawalTx(...args),
  buildRingTransferTx: (...args: unknown[]) => buildRingTransferTx(...args),
}));

vi.mock("./wallet.js", () => ({
  hydrateWallet: (...args: unknown[]) => hydrateWallet(...args),
}));

const { buildRingsOperation } = await import("./build.js");

const OWNER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const BLOCKHASH = "5DjPMLBWWLbNw3TRUEbCwPFvpXqhkdVv2VUb3RJhZmpJ";
const PROTOCOL_PROGRAM = address("11111111111111111111111111111111");
const COMPUTE_BUDGET_PROGRAM = address("ComputeBudget111111111111111111111111111111");
const RING_PROGRAM = "Stake11111111111111111111111111111111111111";
const RING_LOOKUP_TABLE = "LookupTab1e11111111111111111111111111111111";
/** The tag byte a ring program's own deposit instruction leads with. */
const RING_DEPOSIT_TAG = 14;

function operationInput(): BuildOperationInput {
  return {
    owner: OWNER,
    operation: {
      id: "op_1",
      walletId: "hrw_1",
      opType: "withdraw",
      state: "proving",
      approvalRequestId: null,
      policyEvaluationId: null,
      proof: null,
      outerTxSignature: null,
      photonIndexedAt: null,
      failure: null,
      ringProgramId: null,
      input: {
        walletId: "hrw_1",
        opType: "withdraw",
        asset: {
          mint: "So11111111111111111111111111111111111111112",
          amountRaw: "1",
        },
        to: OWNER,
        clientNonce: "nonce_1",
      },
      intentKey: "sha256:intent",
      events: [],
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
      retryOfOperationId: null,
    },
  };
}

function deps(): Parameters<typeof buildRingsOperation>[0] {
  return {
    client: {
      getLatestBlockhash: vi.fn().mockResolvedValue({
        blockhash: BLOCKHASH,
        lastValidBlockHeight: 1_000n,
      }),
    } as never,
    material: {
      withMaterial: async (_request: unknown, use: (material: never) => Promise<unknown>) =>
        use({} as never),
    } as never,
    organizationId: "org_1",
    projectId: "proj_1",
  };
}

function protocolInstruction(data = new Uint8Array([99])): Instruction {
  return { programAddress: PROTOCOL_PROGRAM, data };
}

function decodeMessage(result: Awaited<ReturnType<typeof buildRingsOperation>>) {
  const transaction = getTransactionDecoder().decode(
    getBase64Codec().encode(result.outerUnsignedTxBase64)
  );
  return getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
}

describe("buildRingsOperation manual transaction assembly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hydrateWallet.mockResolvedValue({ wallet: {} });
    buildWithdrawal.mockResolvedValue({
      instructions: [protocolInstruction()],
      inputNotes: ["note_1"],
    });
  });

  it("prepends the maximum compute-unit limit before the protocol instruction", async () => {
    const result = await buildRingsOperation(deps(), operationInput());
    const message = decodeMessage(result);

    if (message.version !== 0) {
      throw new Error("Expected a v0 Rings transaction");
    }

    expect(
      message.instructions.map(
        (instruction) => message.staticAccounts[instruction.programAddressIndex]
      )
    ).toEqual([COMPUTE_BUDGET_PROGRAM, PROTOCOL_PROGRAM]);
    expect(message.instructions[0]?.data).toEqual(new Uint8Array([2, 0xc0, 0x5c, 0x15, 0]));
    expect(message.instructions).toHaveLength(2);
  });

  it("rejects an oversized transaction before returning it", async () => {
    buildWithdrawal.mockResolvedValue({
      instructions: [protocolInstruction(new Uint8Array(1_300))],
      inputNotes: ["note_1"],
    });

    await expect(buildRingsOperation(deps(), operationInput())).rejects.toMatchObject({
      name: "HeliusRingsError",
      code: "invalid_input",
      message: "the Rings request contains invalid input",
    });
  });
});

describe("buildRingsOperation ring-bound operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function ringShieldInput(): BuildOperationInput {
    const base = operationInput();
    return {
      ...base,
      operation: {
        ...base.operation,
        opType: "shield",
        ringProgramId: RING_PROGRAM,
        input: {
          walletId: "hrw_1",
          opType: "shield",
          asset: {
            mint: "So11111111111111111111111111111111111111112",
            amountRaw: "10",
          },
          clientNonce: "nonce_1",
        },
      },
    };
  }

  /** The shield path runs the real ring builder, so it needs real material. */
  function shieldDeps(): Parameters<typeof buildRingsOperation>[0] {
    return {
      ...deps(),
      client: {
        tree: DEFAULT_TREE_ADDRESS,
        getLatestBlockhash: vi.fn().mockResolvedValue({
          blockhash: BLOCKHASH,
          lastValidBlockHeight: 1_000n,
        }),
      } as never,
      material: createDeterministicMaterialSource({ seed: TEST_SEED }),
    };
  }

  it("builds a ring-pinned shield as the ring's own single tag-14 instruction", async () => {
    const result = await buildRingsOperation(shieldDeps(), ringShieldInput());
    const message = decodeMessage(result);

    if (message.version !== 0) {
      throw new Error("Expected a v0 Rings transaction");
    }

    expect(message.instructions).toHaveLength(1);
    const instruction = message.instructions[0];
    expect(message.staticAccounts[instruction?.programAddressIndex ?? -1]).toBe(
      address(RING_PROGRAM)
    );
    expect(instruction?.data?.[0]).toBe(RING_DEPOSIT_TAG);
  });

  it("refuses a ring-pinned spend without its lookup table before the wallet read", async () => {
    const buildDeps = deps();
    const base = operationInput();
    const input = {
      ...base,
      operation: { ...base.operation, ringProgramId: RING_PROGRAM },
    };

    await expect(buildRingsOperation(buildDeps, input)).rejects.toMatchObject({
      name: "HeliusRingsError",
      code: "config_error",
      message: "a ring-bound spend needs the ring's lookup table; resume ring bring-up",
    });
    expect(vi.mocked(buildDeps.client.getLatestBlockhash)).not.toHaveBeenCalled();
    expect(hydrateWallet).not.toHaveBeenCalled();
    expect(buildRingWithdrawalTx).not.toHaveBeenCalled();
  });

  it("routes a ring-pinned withdrawal through the ring builder with no pinned notes", async () => {
    hydrateWallet.mockResolvedValue({ wallet: { fake: "wallet" } });
    buildRingWithdrawalTx.mockResolvedValue(
      compileTransaction(
        pipe(
          createTransactionMessage({ version: 0 }),
          (message) => setTransactionMessageFeePayer(address(OWNER), message),
          (message) =>
            setTransactionMessageLifetimeUsingBlockhash(
              { blockhash: BLOCKHASH as Blockhash, lastValidBlockHeight: 999n },
              message
            )
        )
      )
    );

    const buildDeps = deps();
    const base = operationInput();
    const input = {
      ...base,
      // Pinned inputs are deliberately ignored on the ring path: the one-call
      // builder re-selects same-ring notes on every build.
      pinnedInputs: ["note_1"],
      ring: { programId: RING_PROGRAM, lookupTable: RING_LOOKUP_TABLE },
      operation: { ...base.operation, ringProgramId: RING_PROGRAM },
    };

    const result = await buildRingsOperation(buildDeps, input);

    expect(buildWithdrawal).not.toHaveBeenCalled();
    expect(buildRingWithdrawalTx).toHaveBeenCalledTimes(1);
    const [, ringInput] = buildRingWithdrawalTx.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(ringInput).toMatchObject({
      ringProgramId: RING_PROGRAM,
      lookupTable: RING_LOOKUP_TABLE,
      mint: "So11111111111111111111111111111111111111112",
      amountRaw: "1",
      recipient: OWNER,
    });
    expect(ringInput).not.toHaveProperty("pinnedInputs");
    // No pinned-note contract: input_notes round-trips as [] like a shield's,
    // and the recorded expiry floors on the pre-build blockhash read.
    expect(result.inputNotes).toEqual([]);
    expect(result.lastValidBlockHeight).toBe("1000");
    expect(result.requiredSigners).toEqual([OWNER]);
  });
});
