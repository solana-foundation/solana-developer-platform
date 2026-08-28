import type { Address } from "@solana/kit";
import { getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import type { WisdomTreeChainReader } from "./chain";
import { SdpWisdomTreeError } from "./errors";

/**
 * SPL transfer-hook account resolution — the standard
 * `spl-tlv-account-resolution` algorithm reimplemented over `@solana/kit`,
 * because a fund-token transfer is INVALID without it: Token-2022 CPIs the
 * hook's `execute` on every transfer of a hooked mint, and the accounts that
 * call needs must already ride the outer TransferChecked instruction.
 *
 * The account list is data, not code: the hook program publishes an
 * `ExtraAccountMetaList` account (PDA `["extra-account-metas", mint]`) whose
 * entries are either literal pubkeys or PDA RECIPES — seed programs referencing
 * the execute instruction's own accounts and data. This module fetches that
 * account and evaluates the recipes exactly the way SPL's own
 * `addExtraAccountMetasForExecute` does, so what SDP appends is what the
 * runtime will demand.
 *
 * For WisdomTree specifically this is the KYC surface: the resolved accounts
 * include the compliance state the hook checks (the registrar-issued SBT
 * credential among them), and a transfer from or to an unverified wallet fails
 * HERE — at resolution when a required account cannot be derived, or on-chain
 * when the hook's execute refuses. Both are the compliance model working.
 */

/** First 8 bytes of sha256("spl-transfer-hook-interface:execute") — pinned by test. */
export const TRANSFER_HOOK_EXECUTE_DISCRIMINATOR = Uint8Array.from([
  105, 37, 101, 197, 75, 251, 102, 26,
]);

const EXTRA_ACCOUNT_META_SIZE = 35;
/** Seed-config tags, per spl-tlv-account-resolution. */
const SEED_LITERAL = 1;
const SEED_INSTRUCTION_DATA = 2;
const SEED_ACCOUNT_KEY = 3;
const SEED_ACCOUNT_DATA = 4;

const addressEncoder = getAddressEncoder();

export interface ResolvedHookAccount {
  address: Address;
  isSigner: boolean;
  isWritable: boolean;
}

/** The hook's validation account: PDA `["extra-account-metas", mint]` on the hook program. */
export async function deriveExtraAccountMetasAddress(
  hookProgram: Address,
  mint: Address
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: hookProgram,
    seeds: ["extra-account-metas", addressEncoder.encode(mint)],
  });
  return pda;
}

interface ExtraAccountMetaEntry {
  discriminator: number;
  addressConfig: Uint8Array;
  isSigner: boolean;
  isWritable: boolean;
}

/** Parse the ExtraAccountMetaList TLV out of the validation account's data. */
export function parseExtraAccountMetaList(data: Uint8Array): ExtraAccountMetaEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  while (offset + 12 <= data.length) {
    const discriminator = data.subarray(offset, offset + 8);
    const length = view.getUint32(offset + 8, true);
    const valueStart = offset + 12;
    if (valueStart + length > data.length) {
      throw new SdpWisdomTreeError(
        "HOOK_UNRESOLVED",
        "ExtraAccountMetaList TLV overruns the validation account data."
      );
    }
    if (TRANSFER_HOOK_EXECUTE_DISCRIMINATOR.every((byte, index) => discriminator[index] === byte)) {
      const count = view.getUint32(valueStart, true);
      const entries: ExtraAccountMetaEntry[] = [];
      let entryOffset = valueStart + 4;
      for (let index = 0; index < count; index += 1) {
        if (entryOffset + EXTRA_ACCOUNT_META_SIZE > valueStart + length) {
          throw new SdpWisdomTreeError(
            "HOOK_UNRESOLVED",
            "ExtraAccountMetaList declares more entries than its TLV holds."
          );
        }
        entries.push({
          discriminator: data[entryOffset] as number,
          addressConfig: data.subarray(entryOffset + 1, entryOffset + 33),
          isSigner: data[entryOffset + 33] === 1,
          isWritable: data[entryOffset + 34] === 1,
        });
        entryOffset += EXTRA_ACCOUNT_META_SIZE;
      }
      return entries;
    }
    offset = valueStart + length;
  }
  throw new SdpWisdomTreeError(
    "HOOK_UNRESOLVED",
    "The validation account carries no execute-instruction ExtraAccountMetaList."
  );
}

function decodeBase58Address(value: Address): Uint8Array {
  return Uint8Array.from(addressEncoder.encode(value));
}

/** Evaluate one entry's seed program against the execute instruction being assembled. */
async function unpackSeeds(
  reader: WisdomTreeChainReader,
  addressConfig: Uint8Array,
  executeKeys: readonly ResolvedHookAccount[],
  instructionData: Uint8Array
): Promise<Uint8Array[]> {
  const seeds: Uint8Array[] = [];
  let offset = 0;
  while (offset < addressConfig.length) {
    const tag = addressConfig[offset] as number;
    if (tag === 0) break; // zero padding = end of seed list
    if (tag === SEED_LITERAL) {
      const length = addressConfig[offset + 1] as number;
      seeds.push(addressConfig.subarray(offset + 2, offset + 2 + length));
      offset += 2 + length;
      continue;
    }
    if (tag === SEED_INSTRUCTION_DATA) {
      const index = addressConfig[offset + 1] as number;
      const length = addressConfig[offset + 2] as number;
      if (index + length > instructionData.length) {
        throw new SdpWisdomTreeError(
          "HOOK_UNRESOLVED",
          "A hook seed references execute-instruction data beyond its length."
        );
      }
      seeds.push(instructionData.subarray(index, index + length));
      offset += 3;
      continue;
    }
    if (tag === SEED_ACCOUNT_KEY) {
      const index = addressConfig[offset + 1] as number;
      const key = executeKeys[index];
      if (!key) {
        throw new SdpWisdomTreeError(
          "HOOK_UNRESOLVED",
          `A hook seed references execute account index ${index}, which is not present yet.`
        );
      }
      seeds.push(decodeBase58Address(key.address));
      offset += 2;
      continue;
    }
    if (tag === SEED_ACCOUNT_DATA) {
      const accountIndex = addressConfig[offset + 1] as number;
      const dataIndex = addressConfig[offset + 2] as number;
      const length = addressConfig[offset + 3] as number;
      const key = executeKeys[accountIndex];
      if (!key) {
        throw new SdpWisdomTreeError(
          "HOOK_UNRESOLVED",
          `A hook seed references execute account index ${accountIndex}, which is not present yet.`
        );
      }
      const account = await reader.getAccount(key.address);
      if (!account || dataIndex + length > account.data.length) {
        throw new SdpWisdomTreeError(
          "HOOK_UNRESOLVED",
          `A hook seed needs ${length} bytes of ${key.address}'s data, which is missing or short. ` +
            "For WisdomTree this usually means a compliance account for one of the wallets does " +
            "not exist — the wallet has not been verified by the issuer."
        );
      }
      seeds.push(account.data.subarray(dataIndex, dataIndex + length));
      offset += 4;
      continue;
    }
    throw new SdpWisdomTreeError("HOOK_UNRESOLVED", `Unknown hook seed tag ${tag}.`);
  }
  return seeds;
}

export interface TransferHookResolutionInput {
  hookProgram: Address;
  mint: Address;
  /** The transfer's token accounts and authority, in TransferChecked order. */
  source: Address;
  destination: Address;
  owner: Address;
  /** Base units the transfer encodes — part of the execute data seeds may reference. */
  amount: bigint;
}

/**
 * The accounts to APPEND to a TransferChecked of a hooked mint: the resolved
 * extra metas, then the hook program, then the validation account — the exact
 * order and privilege de-escalation of SPL's `addExtraAccountMetasForExecute`.
 */
export async function resolveTransferHookAccounts(
  reader: WisdomTreeChainReader,
  input: TransferHookResolutionInput
): Promise<ResolvedHookAccount[]> {
  const validationAddress = await deriveExtraAccountMetasAddress(input.hookProgram, input.mint);
  const validationAccount = await reader.getAccount(validationAddress);
  if (validationAccount === null) {
    throw new SdpWisdomTreeError(
      "HOOK_UNRESOLVED",
      `The hook program publishes no ExtraAccountMetaList for mint ${input.mint} at ${validationAddress}.`
    );
  }
  if (validationAccount.owner !== String(input.hookProgram)) {
    throw new SdpWisdomTreeError(
      "HOOK_UNRESOLVED",
      `Validation account ${validationAddress} is owned by ${validationAccount.owner}, not the hook program.`
    );
  }
  const entries = parseExtraAccountMetaList(validationAccount.data);

  // The execute instruction's data: discriminator ++ amount, which
  // instruction-data seeds may slice.
  const executeData = new Uint8Array(16);
  executeData.set(TRANSFER_HOOK_EXECUTE_DISCRIMINATOR, 0);
  new DataView(executeData.buffer).setBigUint64(8, input.amount, true);

  // Execute's base accounts, in interface order; seed account-key indexes
  // reference this list AS IT GROWS.
  const executeKeys: ResolvedHookAccount[] = [
    { address: input.source, isSigner: false, isWritable: true },
    { address: input.mint, isSigner: false, isWritable: false },
    { address: input.destination, isSigner: false, isWritable: true },
    { address: input.owner, isSigner: true, isWritable: false },
    { address: validationAddress, isSigner: false, isWritable: false },
  ];

  for (const entry of entries) {
    let resolvedAddress: Address;
    if (entry.discriminator === 0) {
      resolvedAddress = getAddressDecoder().decode(entry.addressConfig);
    } else {
      const seeds = await unpackSeeds(reader, entry.addressConfig, executeKeys, executeData);
      let programAddress: Address;
      if (entry.discriminator === 1) {
        programAddress = input.hookProgram;
      } else {
        const programIndex = entry.discriminator - (1 << 7);
        const programKey = executeKeys[programIndex];
        if (!programKey) {
          throw new SdpWisdomTreeError(
            "HOOK_UNRESOLVED",
            `A hook meta derives from execute account index ${programIndex}, which is not present.`
          );
        }
        programAddress = programKey.address;
      }
      const [pda] = await getProgramDerivedAddress({ programAddress, seeds });
      resolvedAddress = pda;
    }
    executeKeys.push({
      address: resolvedAddress,
      isSigner: entry.isSigner,
      isWritable: entry.isWritable,
    });
  }

  // The accounts the OUTER transfer carries: extras (execute keys past the five
  // base ones), then the hook program, then the validation account. The
  // runtime demands signer/writable privileges never ESCALATE past what the
  // outer instruction grants, so extras are appended read-only-signerless
  // unless the entry itself asked for more.
  return [
    ...executeKeys.slice(5),
    { address: input.hookProgram, isSigner: false, isWritable: false },
    { address: validationAddress, isSigner: false, isWritable: false },
  ];
}
