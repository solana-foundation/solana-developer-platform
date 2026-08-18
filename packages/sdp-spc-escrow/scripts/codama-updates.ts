// biome-ignore-all lint/security/noSecrets: public Solana program IDs / node names, not secrets.
/**
 * Codama transform updates for the Private Channels escrow client.
 *
 * Adapted from the `private-channel-escrow-program` repository's
 * `scripts/lib/updates/*`, with two changes so the client targets the deployed
 * devnet program:
 *   - `overrideProgramId` repoints the program from the IDL's placeholder
 *     (`GokvZqD2…`) to the REAL deployed escrow program (`9tgHa1…`), so the
 *     generated `PROGRAM_ADDRESS` and every PDA deriver (allowedMint,
 *     eventAuthority) resolve under the real program.
 *   - the `eventAuthority` instruction-account default is a PDA DERIVER (not a
 *     hardcoded pubkey), so it recomputes correctly under the overridden program.
 */

import {
  accountBumpValueNode,
  accountValueNode,
  addPdasVisitor,
  assertIsNode,
  bottomUpTransformerVisitor,
  type Codama,
  constantPdaSeedNode,
  isNode,
  numberTypeNode,
  pdaLinkNode,
  pdaNode,
  pdaSeedValueNode,
  pdaValueNode,
  publicKeyTypeNode,
  publicKeyValueNode,
  setInstructionAccountDefaultValuesVisitor,
  stringTypeNode,
  stringValueNode,
  structFieldTypeNode,
  updateInstructionsVisitor,
  updateProgramsVisitor,
  variablePdaSeedNode,
} from "codama";

const PROGRAM_NODE = "privateChannelEscrowProgram";
const ATA_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
// Classic SPL Token program — SPC channel token accounts + escrow use classic Token, not Token-2022.
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/**
 * Repoint the program to the real deployed escrow id. The IDL declares the
 * placeholder `GokvZqD2…`; the devnet deployment is `realProgramId` (mirror of
 * `SANDBOX_DEFAULTS.escrowProgramId` in `@sdp/private-channels`).
 */
export function overrideProgramId(codama: Codama, realProgramId: string): Codama {
  codama.update(
    updateProgramsVisitor({
      [PROGRAM_NODE]: { publicKey: realProgramId },
    })
  );
  return codama;
}

/** Prepend a `u8` discriminator field to every account struct. */
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

/** Register the program PDAs (instance, allowedMint, operator, eventAuthority). */
export function appendPdaDerivers(codama: Codama): Codama {
  codama.update(
    addPdasVisitor({
      [PROGRAM_NODE]: [
        {
          name: "instance",
          seeds: [
            constantPdaSeedNode(stringTypeNode("utf8"), stringValueNode("instance")),
            variablePdaSeedNode("instanceSeed", publicKeyTypeNode()),
          ],
        },
        {
          name: "allowedMint",
          seeds: [
            constantPdaSeedNode(stringTypeNode("utf8"), stringValueNode("allowed_mint")),
            variablePdaSeedNode("instance", publicKeyTypeNode()),
            variablePdaSeedNode("mint", publicKeyTypeNode()),
          ],
        },
        {
          name: "operator",
          seeds: [
            constantPdaSeedNode(stringTypeNode("utf8"), stringValueNode("operator")),
            variablePdaSeedNode("instance", publicKeyTypeNode()),
            variablePdaSeedNode("wallet", publicKeyTypeNode()),
          ],
        },
        {
          name: "eventAuthority",
          seeds: [constantPdaSeedNode(stringTypeNode("utf8"), stringValueNode("event_authority"))],
        },
      ],
    })
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
 * Default-resolve instruction accounts. Program constants + PDA derivers so
 * callers only pass domain inputs. `eventAuthority` + `privateChannelEscrowProgram`
 * resolve under the overridden program id.
 */
export function setInstructionAccountDefaultValues(codama: Codama, realProgramId: string): Codama {
  codama.update(
    setInstructionAccountDefaultValuesVisitor([
      { account: "privateChannelEscrowProgram", defaultValue: publicKeyValueNode(realProgramId) },
      { account: "systemProgram", defaultValue: publicKeyValueNode(SYSTEM_PROGRAM_ID) },
      { account: "tokenProgram", defaultValue: publicKeyValueNode(TOKEN_PROGRAM_ID) },
      { account: "associatedTokenProgram", defaultValue: publicKeyValueNode(ATA_PROGRAM_ID) },
      // PDA deriver (seed "event_authority") so it recomputes under the real program.
      { account: "eventAuthority", defaultValue: pdaValueNode(pdaLinkNode("eventAuthority"), []) },
      { account: "instanceAta", defaultValue: ataPdaValueNode("instance", "mint", "tokenProgram") },
      {
        account: "allowedMint",
        defaultValue: pdaValueNode(pdaLinkNode("allowedMint"), [
          pdaSeedValueNode("instance", accountValueNode("instance")),
          pdaSeedValueNode("mint", accountValueNode("mint")),
        ]),
      },
      {
        account: "operatorPda",
        defaultValue: pdaValueNode(pdaLinkNode("operator"), [
          pdaSeedValueNode("instance", accountValueNode("instance")),
          pdaSeedValueNode("wallet", accountValueNode("operator")),
        ]),
      },
      {
        account: "instance",
        defaultValue: pdaValueNode(pdaLinkNode("instance"), [
          pdaSeedValueNode("instanceSeed", accountValueNode("instanceSeed")),
        ]),
      },
      { account: "userAta", defaultValue: ataPdaValueNode("user", "mint", "tokenProgram") },
    ])
  );
  return codama;
}

/** Default the `bump` args to the matching account bump. */
export function updateInstructionBumps(codama: Codama): Codama {
  codama.update(
    updateInstructionsVisitor({
      createInstance: { arguments: { bump: { defaultValue: accountBumpValueNode("instance") } } },
      allowMint: { arguments: { bump: { defaultValue: accountBumpValueNode("allowedMint") } } },
      addOperator: { arguments: { bump: { defaultValue: accountBumpValueNode("operatorPda") } } },
    })
  );
  return codama;
}

/** Drop the CPI-only `emitEvent` instruction (not called client-side). */
export function removeEmitInstruction(codama: Codama): Codama {
  codama.update(updateInstructionsVisitor({ emitEvent: { delete: true } }));
  return codama;
}
