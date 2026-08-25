import type { BuildOperationInput } from "@sdp/helius-rings";
import { beforeEach, describe, expect, it, vi } from "vitest";

const buildTransfer = vi.fn();
const hydrateWallet = vi.fn();

vi.mock("./flows/spend.js", () => ({
  buildMerge: vi.fn(),
  buildTransfer: (...args: unknown[]) => buildTransfer(...args),
  buildWithdrawal: vi.fn(),
}));

vi.mock("./wallet.js", () => ({
  hydrateWallet: (...args: unknown[]) => hydrateWallet(...args),
}));

const { buildRingsOperation } = await import("./build.js");

const OWNER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const BLOCKHASH = "5DjPMLBWWLbNw3TRUEbCwPFvpXqhkdVv2VUb3RJhZmpJ";

function operationInput(): BuildOperationInput {
  return {
    owner: OWNER,
    operation: {
      id: "op_1",
      walletId: "hrw_1",
      opType: "transfer_anonymous",
      state: "proving",
      approvalRequestId: null,
      policyEvaluationId: null,
      proof: null,
      outerTxSignature: null,
      photonIndexedAt: null,
      failure: null,
      input: {
        walletId: "hrw_1",
        opType: "transfer_anonymous",
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

describe("buildRingsOperation dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hydrateWallet.mockResolvedValue({ wallet: {} });
    buildTransfer.mockResolvedValue({ instructions: [], inputNotes: [] });
  });

  it("rejects an unsupported operation instead of building a registered transfer", async () => {
    await expect(buildRingsOperation(deps(), operationInput())).rejects.toMatchObject({
      name: "HeliusRingsError",
      code: "invalid_input",
      message: "unsupported Rings operation type: transfer_anonymous",
    });
    expect(buildTransfer).not.toHaveBeenCalled();
  });
});
