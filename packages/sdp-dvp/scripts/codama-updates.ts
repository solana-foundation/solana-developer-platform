// biome-ignore-all lint/security/noSecrets: public Solana program IDs, not secrets.
/**
 * Codama transform updates for the DvP swap client.
 *
 * Ported from the `solana-foundation/dvp` repository's `scripts/lib/updates/*`
 * (MIT). Both transforms below are load-bearing for correctness, not
 * cosmetics — re-derive them from upstream rather than dropping either if a
 * codama upgrade breaks them.
 */

import {
  assertIsNode,
  bottomUpTransformerVisitor,
  type Codama,
  optionTypeNode,
  publicKeyValueNode,
  setInstructionAccountDefaultValuesVisitor,
  structFieldTypeNode,
} from "codama";

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const ATA_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/**
 * Default-resolve only the two accounts that are genuinely constant.
 *
 * `tokenProgram` (singular, on ReclaimDvp) is deliberately NOT defaulted.
 * The program stores a per-leg token program at CreateDvp and rejects a
 * mismatch, so defaulting it to legacy SPL would make every Token-2022 leg
 * fail with IncorrectProgramId. Callers pass the funded leg's token program
 * explicitly. This mirrors upstream's fix for EXO-219/221 — do not "tidy" it
 * by adding a default here.
 */
export function setInstructionAccountDefaultValues(codama: Codama): Codama {
  codama.update(
    setInstructionAccountDefaultValuesVisitor([
      { account: "systemProgram", defaultValue: publicKeyValueNode(SYSTEM_PROGRAM_ID) },
      { account: "associatedTokenProgram", defaultValue: publicKeyValueNode(ATA_PROGRAM_ID) },
    ])
  );
  return codama;
}

/**
 * The on-chain `SwapDvp.earliest_settlement_timestamp` is fixed-width (1 tag
 * byte + 8 payload bytes, even for `None`, whose payload is a sentinel), but
 * the IDL models it as a plain Borsh `Option<i64>`. Left alone, the generated
 * codec accepts a short layout the program itself rejects — which is a
 * forgery surface, since a decoded-but-invalid SwapDvp is what a funder would
 * deposit against.
 *
 * Marking the account field's option `fixed` makes the codec consume and emit
 * exactly 1 + 8 bytes, with the tag as source of truth. Instruction args stay
 * variable-length Borsh.
 */
export function setFixedAccountOptionFields(codama: Codama): Codama {
  let matched = 0;
  codama.update(
    bottomUpTransformerVisitor([
      {
        select: "[accountNode]swapDvp.[structFieldTypeNode]earliestSettlementTimestamp",
        transform: (node) => {
          assertIsNode(node, "structFieldTypeNode");
          assertIsNode(node.type, "optionTypeNode");
          matched += 1;
          return structFieldTypeNode({
            ...node,
            type: optionTypeNode(node.type.item, {
              prefix: node.type.prefix,
              fixed: true,
            }),
          });
        },
      },
    ])
  );
  // Fail codegen if the selector stops matching (a codama or IDL rename). A
  // silent no-op ships a SwapDvp codec that falls back to variable-width
  // Option and accepts the forged short layout.
  if (matched !== 1) {
    throw new Error(
      `setFixedAccountOptionFields: expected to patch exactly 1 SwapDvp option field, ` +
        `patched ${matched}. The generated codec would accept the forged short layout; ` +
        `refusing to render.`
    );
  }
  return codama;
}
