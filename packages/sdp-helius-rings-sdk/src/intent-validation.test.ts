import type { PreparedTransfer, ProofOutputUtxo } from "@heliuslabs/zolana/transaction";
import { createProofOutput } from "@heliuslabs/zolana/transaction";
import { type Address, address } from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type PreparedSpendIntent, validatePreparedTransferIntent } from "./intent-validation.js";
import {
  createShieldedMaterial,
  type ShieldedMaterial,
  type ShieldedMaterialInput,
} from "./material.js";

const OWNER = "GsbwXfJraMomNxBcjK1DiP5Mth8ZmQpDUFTmKfhtiHgo";
const RECIPIENT = "6Ecs4vFmtiZ7WeQMWZibhFPQF3q3Pmqrb7CQGRJJKQTM";
const OTHER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const SOL = address("11111111111111111111111111111111");
const OTHER_ASSET = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

const OWNER_INPUT: ShieldedMaterialInput = {
  viewingKeyBytes: new Uint8Array(32).fill(7),
  nullifierKeyBytes: new Uint8Array(31).fill(11),
  owner: OWNER,
};

let ownerMaterial: ShieldedMaterial;
let recipientMaterial: ShieldedMaterial;
let otherMaterial: ShieldedMaterial;
type SettlementTransfer = PreparedTransfer["interfaceTransfers"][number];

beforeAll(async () => {
  ownerMaterial = await createShieldedMaterial(OWNER_INPUT);
  recipientMaterial = await createShieldedMaterial({
    viewingKeyBytes: new Uint8Array(32).fill(8),
    nullifierKeyBytes: new Uint8Array(31).fill(12),
    owner: RECIPIENT,
  });
  otherMaterial = await createShieldedMaterial({
    viewingKeyBytes: new Uint8Array(32).fill(9),
    nullifierKeyBytes: new Uint8Array(31).fill(13),
    owner: OTHER,
  });
});

afterAll(() => {
  ownerMaterial.destroy();
  recipientMaterial.destroy();
  otherMaterial.destroy();
});

function dummyOutput(): ProofOutputUtxo {
  return createProofOutput({
    asset: SOL,
    amount: 0n,
    ownerTag: ownerMaterial.shieldedAddress.confidentialViewTag(),
  });
}

function ownerOutput(asset: Address = SOL, amount = 4n): ProofOutputUtxo {
  return createProofOutput({
    ownerAddress: ownerMaterial.shieldedAddress,
    asset,
    amount,
  });
}

function recipientOutput(
  owner = recipientMaterial,
  asset: Address = SOL,
  amount = 10n
): ProofOutputUtxo {
  return createProofOutput({
    ownerAddress: owner.shieldedAddress,
    asset,
    amount,
  });
}

function prepared(
  outputs: readonly ProofOutputUtxo[],
  overrides: {
    owner?: ShieldedMaterial;
    payer?: string;
    interfaceTransfers?: readonly SettlementTransfer[];
  } = {}
): PreparedTransfer {
  return {
    owner: (overrides.owner ?? ownerMaterial).shieldedAddress,
    payer: address(overrides.payer ?? OWNER),
    inputs: [],
    outputs,
    firstNullifier: new Uint8Array(32),
    shape: { inputs: 1, outputs: 4 },
    interfaceTransfers: overrides.interfaceTransfers ?? [],
    finalize: () => {
      throw new Error("not used by intent validation");
    },
  } as unknown as PreparedTransfer;
}

function transferIntent(overrides: Partial<PreparedSpendIntent> = {}): PreparedSpendIntent {
  return {
    kind: "transfer_registered",
    owner: address(OWNER),
    recipient: recipientMaterial.shieldedAddress,
    asset: SOL,
    amount: 10n,
    ...overrides,
  } as PreparedSpendIntent;
}

function withdrawalIntent(overrides: Partial<PreparedSpendIntent> = {}): PreparedSpendIntent {
  return {
    kind: "withdraw",
    owner: address(OWNER),
    recipient: address(RECIPIENT),
    amount: 10n,
    ...overrides,
  } as PreparedSpendIntent;
}

function expectPolicyError(work: () => void): void {
  let thrown: unknown;
  try {
    work();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toMatchObject({
    name: "HeliusRingsError",
    code: "invalid_input",
    message: "the prepared Rings transfer does not match the requested intent",
  });
}

describe("validatePreparedTransferIntent", () => {
  describe("registered transfer", () => {
    it("accepts two sender slots and one exact registered-recipient output", () => {
      const value = prepared([dummyOutput(), ownerOutput(), recipientOutput()]);

      expect(() => validatePreparedTransferIntent(value, transferIntent())).not.toThrow();
    });

    it.each([
      [
        "prepared owner",
        () => prepared([dummyOutput(), ownerOutput(), recipientOutput()], { owner: otherMaterial }),
      ],
      [
        "prepared payer",
        () => prepared([dummyOutput(), ownerOutput(), recipientOutput()], { payer: OTHER }),
      ],
      [
        "public settlement",
        () =>
          prepared([dummyOutput(), ownerOutput(), recipientOutput()], {
            interfaceTransfers: [
              {
                kind: "sol",
                isDeposit: false,
                amount: 10n,
                userSolAccount: address(RECIPIENT),
              },
            ],
          }),
      ],
      [
        "extra private output",
        () => prepared([dummyOutput(), ownerOutput(), recipientOutput(), recipientOutput()]),
      ],
      [
        "retargeted sender slot",
        () =>
          prepared([dummyOutput(), recipientOutput(recipientMaterial, SOL, 1n), recipientOutput()]),
      ],
      [
        "recipient identity",
        () => prepared([dummyOutput(), ownerOutput(), recipientOutput(otherMaterial)]),
      ],
      [
        "recipient asset",
        () =>
          prepared([dummyOutput(), ownerOutput(), recipientOutput(recipientMaterial, OTHER_ASSET)]),
      ],
      [
        "recipient amount",
        () =>
          prepared([dummyOutput(), ownerOutput(), recipientOutput(recipientMaterial, SOL, 11n)]),
      ],
    ])("rejects a mismatched %s", (_field, buildPrepared) => {
      expectPolicyError(() => validatePreparedTransferIntent(buildPrepared(), transferIntent()));
    });
  });

  describe("withdrawal", () => {
    function settlement(
      overrides: Partial<Extract<SettlementTransfer, { kind: "sol" }>> = {}
    ): SettlementTransfer {
      return {
        kind: "sol",
        isDeposit: false,
        amount: 10n,
        userSolAccount: address(RECIPIENT),
        ...overrides,
      };
    }

    it("accepts only sender slots and one exact SOL withdrawal settlement", () => {
      const value = prepared([dummyOutput(), ownerOutput()], {
        interfaceTransfers: [settlement()],
      });

      expect(() => validatePreparedTransferIntent(value, withdrawalIntent())).not.toThrow();
    });

    // Draining the notes exactly leaves no change, so the builder emits a
    // zero-value dummy in the sender's SOL slot rather than a change note.
    it("accepts a withdrawal that consumes its notes exactly, leaving no change", () => {
      const value = prepared([dummyOutput(), dummyOutput()], {
        interfaceTransfers: [settlement()],
      });

      expect(() => validatePreparedTransferIntent(value, withdrawalIntent())).not.toThrow();
    });

    it.each([
      [
        "private recipient output",
        () =>
          prepared([dummyOutput(), ownerOutput(), recipientOutput()], {
            interfaceTransfers: [settlement()],
          }),
      ],
      ["missing settlement", () => prepared([dummyOutput(), ownerOutput()])],
      [
        "multiple settlements",
        () =>
          prepared([dummyOutput(), ownerOutput()], {
            interfaceTransfers: [settlement(), settlement()],
          }),
      ],
      [
        "deposit settlement",
        () =>
          prepared([dummyOutput(), ownerOutput()], {
            interfaceTransfers: [settlement({ isDeposit: true })],
          }),
      ],
      [
        "settlement recipient",
        () =>
          prepared([dummyOutput(), ownerOutput()], {
            interfaceTransfers: [settlement({ userSolAccount: address(OTHER) })],
          }),
      ],
      [
        "settlement amount",
        () =>
          prepared([dummyOutput(), ownerOutput()], {
            interfaceTransfers: [settlement({ amount: 11n })],
          }),
      ],
      [
        "SPL settlement",
        () =>
          prepared([dummyOutput(), ownerOutput()], {
            interfaceTransfers: [
              {
                kind: "spl",
                isDeposit: false,
                amount: 10n,
                mint: OTHER_ASSET,
                tokenAccount: address(RECIPIENT),
                splTokenInterface: address(OTHER),
                splInterfaceBump: 1,
              },
            ],
          }),
      ],
    ])("rejects a mismatched %s", (_field, buildPrepared) => {
      expectPolicyError(() => validatePreparedTransferIntent(buildPrepared(), withdrawalIntent()));
    });
  });

  it("does not expose owners, recipients, or amounts in a policy error", () => {
    let thrown: unknown;
    try {
      validatePreparedTransferIntent(
        prepared([dummyOutput(), ownerOutput(), recipientOutput(otherMaterial)]),
        transferIntent()
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).not.toContain(OWNER);
    expect(message).not.toContain(RECIPIENT);
    expect(message).not.toContain("10");
  });
});
