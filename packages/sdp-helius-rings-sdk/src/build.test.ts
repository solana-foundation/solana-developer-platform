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
const buildMerge = vi.fn();
const buildRingEntryTx = vi.fn();
const buildRingExitTx = vi.fn();
const spendKeys = vi.fn();
const destroyKeys = vi.fn();

vi.mock("./flows/spend.js", () => ({
  buildWithdrawal: (...args: unknown[]) => buildWithdrawal(...args),
}));

vi.mock("./flows/merge.js", () => ({
  buildMerge: (...args: unknown[]) => buildMerge(...args),
}));

vi.mock("./keys.js", () => ({
  spendKeys: (...args: unknown[]) => spendKeys(...args),
}));

vi.mock("./flows/ring-spend.js", () => ({
  buildRingWithdrawalTx: (...args: unknown[]) => buildRingWithdrawalTx(...args),
  buildRingTransferTx: (...args: unknown[]) => buildRingTransferTx(...args),
  buildRingEntryTx: (...args: unknown[]) => buildRingEntryTx(...args),
  buildRingExitTx: (...args: unknown[]) => buildRingExitTx(...args),
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
    spendKeys.mockReturnValue({ destroy: destroyKeys });
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
    // The keys are copies of the material, so a build that throws still has to
    // reclaim them rather than leave them to the material's scope.
    expect(destroyKeys).toHaveBeenCalledTimes(1);
  });
});

describe("buildRingsOperation ring-bound operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spendKeys.mockReturnValue({ destroy: destroyKeys });
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

  /** A minimal compiled v0 transaction the mocked one-call builders return. */
  function compiledRingTx() {
    return compileTransaction(
      pipe(
        createTransactionMessage({ version: 0 }),
        (message) => setTransactionMessageFeePayer(address(OWNER), message),
        (message) =>
          setTransactionMessageLifetimeUsingBlockhash(
            { blockhash: BLOCKHASH as Blockhash, lastValidBlockHeight: 999n },
            message
          )
      )
    );
  }

  it("routes a ring-pinned withdrawal through the ring builder with no pinned notes", async () => {
    hydrateWallet.mockResolvedValue({ wallet: { fake: "wallet" } });
    buildRingWithdrawalTx.mockResolvedValue(compiledRingTx());

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

  function ringMoveInput(opType: "ring_exit" | "ring_entry"): BuildOperationInput {
    const base = operationInput();
    return {
      ...base,
      ring: { programId: RING_PROGRAM, lookupTable: RING_LOOKUP_TABLE },
      operation: {
        ...base.operation,
        opType,
        ringProgramId: RING_PROGRAM,
        input: {
          walletId: "hrw_1",
          opType,
          asset: {
            mint: "So11111111111111111111111111111111111111112",
            amountRaw: "1",
          },
          clientNonce: "nonce_1",
        },
      },
    };
  }

  /** Material whose scope opening is observable, carrying the own address a ring exit needs. */
  function ringMoveDeps(self: unknown) {
    const withMaterial = vi.fn(
      async (_request: unknown, use: (material: never) => Promise<unknown>) =>
        use({ shieldedAddress: self } as never)
    );
    return { buildDeps: { ...deps(), material: { withMaterial } as never }, withMaterial };
  }

  it("routes a ring_exit through the exit builder with the wallet's own shielded address", async () => {
    hydrateWallet.mockResolvedValue({ wallet: { fake: "wallet" } });
    buildRingExitTx.mockResolvedValue(compiledRingTx());
    const self = { fake: "own-shielded-address" };
    const { buildDeps, withMaterial } = ringMoveDeps(self);

    const result = await buildRingsOperation(buildDeps, ringMoveInput("ring_exit"));

    expect(buildRingExitTx).toHaveBeenCalledTimes(1);
    const [, ringInput] = buildRingExitTx.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(ringInput).toMatchObject({
      ringProgramId: RING_PROGRAM,
      lookupTable: RING_LOOKUP_TABLE,
      mint: "So11111111111111111111111111111111111111112",
      amountRaw: "1",
    });
    // The exit's only allowed recipient: the wallet's own address, lifted from
    // the material scope already open for the build — never a second load.
    expect(ringInput.recipient).toBe(self);
    expect(withMaterial).toHaveBeenCalledTimes(1);
    expect(result.inputNotes).toEqual([]);
  });

  it("routes a ring_entry through the entry builder without loading any recipient material", async () => {
    hydrateWallet.mockResolvedValue({ wallet: { fake: "wallet" } });
    buildRingEntryTx.mockResolvedValue(compiledRingTx());
    const { buildDeps, withMaterial } = ringMoveDeps({ fake: "own-shielded-address" });

    await buildRingsOperation(buildDeps, ringMoveInput("ring_entry"));

    expect(buildRingEntryTx).toHaveBeenCalledTimes(1);
    const [, ringInput] = buildRingEntryTx.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(ringInput).not.toHaveProperty("recipient");
    expect(withMaterial).toHaveBeenCalledTimes(1);
    expect(buildRingTransferTx).not.toHaveBeenCalled();
    expect(buildRingWithdrawalTx).not.toHaveBeenCalled();
  });

  it("refuses a ring move missing its ring pair before the wallet read, even unpinned", async () => {
    // A null-pinned ring move must be a config_error, never a silent fall
    // into the default-pool spend path.
    const base = ringMoveInput("ring_entry");
    const { ring: _ring, ...withoutRing } = base;
    const input = {
      ...withoutRing,
      operation: { ...base.operation, ringProgramId: null },
    };

    await expect(buildRingsOperation(deps(), input)).rejects.toMatchObject({
      name: "HeliusRingsError",
      code: "config_error",
      message: "a ring-bound spend needs the ring's lookup table; resume ring bring-up",
    });
    expect(hydrateWallet).not.toHaveBeenCalled();
    expect(buildWithdrawal).not.toHaveBeenCalled();
    expect(buildRingEntryTx).not.toHaveBeenCalled();
  });
});

describe("buildRingsOperation merge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spendKeys.mockReturnValue({ destroy: destroyKeys });
    hydrateWallet.mockResolvedValue({ wallet: { fake: "wallet" } });
  });

  function mergeInput(overrides: Partial<BuildOperationInput> = {}): BuildOperationInput {
    const base = operationInput();
    return {
      ...base,
      operation: {
        ...base.operation,
        opType: "merge",
        input: {
          walletId: "hrw_1",
          opType: "merge",
          // No amountRaw: a merge writes back whatever its notes already held.
          asset: { mint: "So11111111111111111111111111111111111111112" },
          clientNonce: "nonce_1",
        },
      },
      ...overrides,
    };
  }

  it("records the merged notes and floors the expiry on the pre-build blockhash", async () => {
    buildMerge.mockResolvedValue({
      transaction: compileTransaction(
        pipe(
          createTransactionMessage({ version: 0 }),
          (message) => setTransactionMessageFeePayer(address(OWNER), message),
          (message) =>
            setTransactionMessageLifetimeUsingBlockhash(
              { blockhash: BLOCKHASH as Blockhash, lastValidBlockHeight: 999n },
              message
            )
        )
      ),
      inputNotes: ["note_1", "note_2"],
    });

    const buildDeps = deps();
    const result = await buildRingsOperation(buildDeps, mergeInput({ pinnedInputs: ["note_1"] }));

    expect(buildWithdrawal).not.toHaveBeenCalled();
    const [, input] = buildMerge.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(input).toMatchObject({
      mint: "So11111111111111111111111111111111111111112",
      pinnedInputs: ["note_1"],
    });
    // The commitments come back so the operation can pin them; a rebuild then
    // consolidates the same notes.
    expect(result.inputNotes).toEqual(["note_1", "note_2"]);
    // The builder blockhashes its own transaction, so the recorded expiry
    // floors on the earlier read rather than the one inside it.
    expect(result.lastValidBlockHeight).toBe("1000");
  });

  it("refuses a ring-pinned merge before the wallet read", async () => {
    const buildDeps = deps();
    const base = mergeInput();
    const input = {
      ...base,
      ring: { programId: RING_PROGRAM, lookupTable: RING_LOOKUP_TABLE },
      operation: { ...base.operation, ringProgramId: RING_PROGRAM },
    };

    // The protocol reserves a tag for a ring merge but ships no builder, so
    // this is refused rather than routed. Unreachable through the route schema.
    await expect(buildRingsOperation(buildDeps, input)).rejects.toMatchObject({
      name: "HeliusRingsError",
      code: "invalid_input",
      message: "ring-bound notes cannot be merged; merge the default ring's notes instead",
    });
    expect(hydrateWallet).not.toHaveBeenCalled();
    expect(buildMerge).not.toHaveBeenCalled();
  });
});
