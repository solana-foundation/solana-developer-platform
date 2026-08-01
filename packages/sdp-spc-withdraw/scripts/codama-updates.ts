// biome-ignore-all lint/security/noSecrets: public Solana program IDs / node names, not secrets.
/**
 * Codama transform updates for the Private Channels withdraw client.
 *
 * Much simpler than the escrow sibling: the withdraw IDL already declares the
 * REAL deployed program id (`J231K9…`), so there is NO program-id override, and
 * the program has no accounts and no PDAs, so there are no PDA derivers or
 * escrow-specific accounts (allowedMint / operator / eventAuthority).
 *
 * The only real work is defaulting the `withdrawFunds` instruction accounts:
 *   - `tokenProgram` / `associatedTokenProgram` → program constants, and
 *   - `tokenAccount` → the user's classic-Token ATA (owner=user, mint, tokenProgram),
 *     derived exactly like escrow's user ATA.
 * `appendAccountDiscriminator` is kept for parity (a no-op here — no accounts).
 */

import {
  accountValueNode,
  assertIsNode,
  bottomUpTransformerVisitor,
  type Codama,
  isNode,
  numberTypeNode,
  pdaNode,
  pdaSeedValueNode,
  pdaValueNode,
  publicKeyTypeNode,
  publicKeyValueNode,
  setInstructionAccountDefaultValuesVisitor,
  structFieldTypeNode,
  variablePdaSeedNode,
} from "codama";

const ATA_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
// Classic SPL Token program — SPC channel token accounts use classic Token, not Token-2022.
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** Prepend a `u8` discriminator field to every account struct (no-op: no accounts). */
export function appendAccountDiscriminator(codama: Codama): Codama {
  codama.update(
    bottomUpTransformerVisitor([
      {
        select: "[accountNode]",
        transform: (node) => {
          assertIsNode(node, "accountNode");
          if (isNode(node.data, "structTypeNode")) {
            const updated = {
              ...node,
              data: {
                ...node.data,
                fields: [
                  structFieldTypeNode({ name: "discriminator", type: numberTypeNode("u8") }),
                  ...node.data.fields,
                ],
              },
            };
            if (node.size !== undefined) {
              return { ...updated, size: (node.size ?? 0) + 1 };
            }
            return updated;
          }
          return node;
        },
      },
    ])
  );
  return codama;
}

function ataPdaValueNode(ownerAccount: string, mintAccount: string, tokenProgram: string) {
  return pdaValueNode(
    pdaNode({
      name: "associatedTokenAccount",
      seeds: [
        variablePdaSeedNode("owner", publicKeyTypeNode()),
        variablePdaSeedNode("tokenProgram", publicKeyTypeNode()),
        variablePdaSeedNode("mint", publicKeyTypeNode()),
      ],
      programId: ATA_PROGRAM_ID,
    }),
    [
      pdaSeedValueNode("owner", accountValueNode(ownerAccount)),
      pdaSeedValueNode("tokenProgram", accountValueNode(tokenProgram)),
      pdaSeedValueNode("mint", accountValueNode(mintAccount)),
    ]
  );
}

/**
 * Default-resolve the `withdrawFunds` instruction accounts. Program constants +
 * the user-ATA deriver so callers only pass domain inputs (`user`, `mint`,
 * `amount`, `destination`).
 */
export function setInstructionAccountDefaultValues(codama: Codama): Codama {
  codama.update(
    setInstructionAccountDefaultValuesVisitor([
      { account: "tokenProgram", defaultValue: publicKeyValueNode(TOKEN_PROGRAM_ID) },
      { account: "associatedTokenProgram", defaultValue: publicKeyValueNode(ATA_PROGRAM_ID) },
      // The user's classic-Token ATA that holds the channel-chain balance being burned.
      { account: "tokenAccount", defaultValue: ataPdaValueNode("user", "mint", "tokenProgram") },
    ])
  );
  return codama;
}
