import type { BuildOperationInput } from "@sdp/helius-rings";
import {
  address,
  getBase64Codec,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Instruction,
} from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const buildWithdrawal = vi.fn();
const hydrateWallet = vi.fn();

vi.mock("./flows/spend.js", () => ({
  buildWithdrawal: (...args: unknown[]) => buildWithdrawal(...args),
}));

vi.mock("./wallet.js", () => ({
  hydrateWallet: (...args: unknown[]) => hydrateWallet(...args),
}));

const { buildRingsOperation } = await import("./build.js");

const OWNER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const BLOCKHASH = "5DjPMLBWWLbNw3TRUEbCwPFvpXqhkdVv2VUb3RJhZmpJ";
const PROTOCOL_PROGRAM = address("11111111111111111111111111111111");
const COMPUTE_BUDGET_PROGRAM = address("ComputeBudget111111111111111111111111111111");

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
