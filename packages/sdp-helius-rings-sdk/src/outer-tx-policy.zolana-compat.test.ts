import {
  DEFAULT_TREE_ADDRESS,
  type TransactInstructionData,
  TransactWithdrawal,
  transactInstruction,
} from "@heliuslabs/zolana/interface";
import {
  address,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase64Codec,
  getTransactionEncoder,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import {
  getSetComputeUnitLimitInstruction,
  MAX_COMPUTE_UNIT_LIMIT,
} from "@solana-program/compute-budget";
import { describe, expect, it } from "vitest";
import { validateOuterTransaction } from "./outer-tx-policy.js";

const OWNER = address("GsbwXfJraMomNxBcjK1DiP5Mth8ZmQpDUFTmKfhtiHgo");
const RECIPIENT = address("6Ecs4vFmtiZ7WeQMWZibhFPQF3q3Pmqrb7CQGRJJKQTM");
const SDP_SOL = "So11111111111111111111111111111111111111112";
const BLOCKHASH = "5DjPMLBWWLbNw3TRUEbCwPFvpXqhkdVv2VUb3RJhZmpJ";

function bytes(length: number, fill: number): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

/**
 * Fixed opaque input used only to make Zolana's exported producer encode its
 * current wire layout. Security behavior remains raw and public-boundary-only
 * in outer-tx-policy.test.ts; do not parameterize these private fields.
 */
function fixedOpaqueProducerInput(
  interfaceTransfers: TransactInstructionData["interfaceTransfers"]
): TransactInstructionData {
  return {
    expiryUnixTs: 0xffff_ffff_ffff_ffffn,
    privateTxHash: bytes(32, 8) as never,
    circuit: {
      kind: "confidentialEddsa",
      inputs: 2,
      outputs: 3,
      publicAssetSlots: 3,
    },
    txViewingPk: bytes(33, 9) as never,
    salt: bytes(16, 10) as never,
    proof: {
      a: bytes(32, 11) as never,
      b: bytes(64, 12) as never,
      c: bytes(32, 13) as never,
    },
    inputs: [
      {
        nullifierHash: bytes(32, 14) as never,
        nullifierTreeRootIndex: 1,
        utxoTreeRootIndex: 2,
      },
      {
        nullifierHash: bytes(32, 15) as never,
        nullifierTreeRootIndex: 1,
        utxoTreeRootIndex: 2,
      },
    ],
    interfaceTransfers,
    outputs: [
      {
        utxoHash: bytes(32, 16) as never,
        ownerTag: { kind: "account", index: 0 },
        data: bytes(12, 40),
      },
      {
        utxoHash: bytes(32, 17) as never,
        ownerTag: { kind: "account", index: 0 },
        data: bytes(12, 41),
      },
      {
        utxoHash: bytes(32, 18) as never,
        ownerTag: { kind: "inline", value: bytes(32, 30) as never },
        data: bytes(12, 42),
      },
    ],
    messages: [],
  };
}

function spendWire(protocolInstruction: Instruction): string {
  const transaction = compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (message) => setTransactionMessageFeePayer(OWNER, message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: BLOCKHASH as Blockhash, lastValidBlockHeight: 100n },
          message
        ),
      (message) =>
        appendTransactionMessageInstructions(
          [
            getSetComputeUnitLimitInstruction({ units: MAX_COMPUTE_UNIT_LIMIT }),
            protocolInstruction,
          ],
          message
        )
    )
  );
  return getBase64Codec().decode(getTransactionEncoder().encode(transaction));
}

describe("validateOuterTransaction Zolana wire compatibility", () => {
  it("accepts a registered transfer produced by Zolana", async () => {
    const instruction = transactInstruction({
      payer: OWNER,
      inputTree: DEFAULT_TREE_ADDRESS,
      outputTree: DEFAULT_TREE_ADDRESS,
      data: fixedOpaqueProducerInput([]),
    });

    await expect(
      validateOuterTransaction({
        outerUnsignedTxBase64: spendWire(instruction),
        owner: OWNER,
        intent: {
          opType: "transfer_registered",
          mint: SDP_SOL,
          amountRaw: "10",
        },
      })
    ).resolves.toBeUndefined();
  });

  it("accepts an exact SOL withdrawal produced by Zolana", async () => {
    const instruction = transactInstruction({
      payer: OWNER,
      inputTree: DEFAULT_TREE_ADDRESS,
      outputTree: DEFAULT_TREE_ADDRESS,
      withdrawal: TransactWithdrawal.sol({ recipient: RECIPIENT }),
      data: fixedOpaqueProducerInput([{ kind: "solWithdrawal", amount: 10n }]),
    });

    await expect(
      validateOuterTransaction({
        outerUnsignedTxBase64: spendWire(instruction),
        owner: OWNER,
        intent: {
          opType: "withdraw",
          mint: SDP_SOL,
          amountRaw: "10",
          to: RECIPIENT,
        },
      })
    ).resolves.toBeUndefined();
  });
});
