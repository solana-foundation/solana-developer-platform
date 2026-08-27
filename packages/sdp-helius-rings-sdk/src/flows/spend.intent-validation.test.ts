import { type Address, address } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  encrypt: vi.fn(),
  prepare: vi.fn(),
  prove: vi.fn(),
  resolveRegisteredAddress: vi.fn(),
  send: vi.fn(),
  transactInstruction: vi.fn(),
  validate: vi.fn(),
  withdraw: vi.fn(),
}));

vi.mock("@heliuslabs/zolana/interface", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@heliuslabs/zolana/interface")>()),
  transactInstruction: (...args: unknown[]) => mocks.transactInstruction(...args),
}));

vi.mock("@heliuslabs/zolana/transaction", async (importOriginal) => {
  const original = await importOriginal<typeof import("@heliuslabs/zolana/transaction")>();
  return {
    ...original,
    ConfidentialTransfer: class {
      send(...args: unknown[]) {
        mocks.send(...args);
      }

      withdraw(...args: unknown[]) {
        mocks.withdraw(...args);
      }

      prepare() {
        return mocks.prepare();
      }
    },
    ProofInputUtxo: class {},
  };
});

vi.mock("@heliuslabs/zolana/wallet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@heliuslabs/zolana/wallet")>()),
  resolveRegisteredAddress: (...args: unknown[]) => mocks.resolveRegisteredAddress(...args),
}));

vi.mock("../intent-validation.js", () => ({
  validatePreparedTransferIntent: (...args: unknown[]) => mocks.validate(...args),
}));

vi.mock("./notes.js", () => ({
  noteId: vi.fn(),
  selectNotes: () => ({
    notes: [{ utxo: {} }],
    ids: ["note_1"],
    total: 20n,
  }),
}));

const { buildTransfer, buildWithdrawal } = await import("./spend.js");

const OWNER = address("GsbwXfJraMomNxBcjK1DiP5Mth8ZmQpDUFTmKfhtiHgo");
const RECIPIENT = address("6Ecs4vFmtiZ7WeQMWZibhFPQF3q3Pmqrb7CQGRJJKQTM");
const SOL: Address = address("11111111111111111111111111111111");
const RECIPIENT_IDENTITY = { id: "registered-recipient" };
const PREPARED = {
  id: "prepared-transfer",
  outputs: [],
  finalize: () => ({ finalized: true }),
};

function deps(): Parameters<typeof buildTransfer>[0] {
  return {
    client: {
      tree: SOL,
      proveTransact: (...args: unknown[]) => mocks.prove(...args),
    } as never,
    wallet: { registry: {} } as never,
    authority: {
      encryptConfidentialTransfer: (...args: unknown[]) => mocks.encrypt(...args),
    } as never,
    material: {
      shieldedAddress: { id: "sender" },
      nullifierKey: {},
    } as never,
    owner: OWNER,
  };
}

describe("spend prepared-intent gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prepare.mockReturnValue(PREPARED);
    mocks.encrypt.mockResolvedValue({ encrypted: true });
    mocks.prove.mockResolvedValue({ proof: true });
    mocks.resolveRegisteredAddress.mockResolvedValue({ address: RECIPIENT_IDENTITY });
    mocks.transactInstruction.mockReturnValue({ programAddress: SOL });
  });

  it("validates the resolved registered-transfer intent before encryption and proving", async () => {
    await buildTransfer(deps(), {
      recipient: RECIPIENT,
      mint: "So11111111111111111111111111111111111111112",
      amountRaw: "10",
    });

    expect(mocks.validate).toHaveBeenCalledWith(PREPARED, {
      kind: "transfer_registered",
      owner: OWNER,
      recipient: RECIPIENT_IDENTITY,
      asset: SOL,
      amount: 10n,
    });
    expect(mocks.validate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.encrypt.mock.invocationCallOrder[0] as number
    );
    expect(mocks.validate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.prove.mock.invocationCallOrder[0] as number
    );
  });

  it("validates the public withdrawal intent before encryption and proving", async () => {
    await buildWithdrawal(deps(), {
      recipient: RECIPIENT,
      mint: "So11111111111111111111111111111111111111112",
      amountRaw: "10",
    });

    expect(mocks.validate).toHaveBeenCalledWith(PREPARED, {
      kind: "withdraw",
      owner: OWNER,
      recipient: RECIPIENT,
      amount: 10n,
    });
    expect(mocks.validate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.encrypt.mock.invocationCallOrder[0] as number
    );
    expect(mocks.validate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.prove.mock.invocationCallOrder[0] as number
    );
  });

  it("does not encrypt or prove when prepared intent validation rejects", async () => {
    mocks.validate.mockImplementation(() => {
      throw new Error("rejected");
    });

    await expect(
      buildTransfer(deps(), {
        recipient: RECIPIENT,
        mint: "So11111111111111111111111111111111111111112",
        amountRaw: "10",
      })
    ).rejects.toThrow("rejected");

    expect(mocks.encrypt).not.toHaveBeenCalled();
    expect(mocks.prove).not.toHaveBeenCalled();
  });
});
