import type { EarnVaultTransactionPlan } from "@sdp/earn/types";
import type { SolanaRpc } from "@sdp/rpc/solana";
import { deriveAssociatedTokenAddress } from "@sdp/solana/address";
import {
  PLUME_CCTP_DOMAIN,
  PLUME_ENDPOINT_ID,
  PLUME_PROGRAMS,
  type PlumeVaultDeployment,
} from "@sdp/types/plume-programs";
import { SPL_TOKEN_PROGRAMS } from "@sdp/types/well-known-tokens";
import {
  type AddressesByLookupTableAddress,
  address,
  blockhash,
  bytesEqual,
  decompileTransactionMessage,
  fetchAddressesForLookupTables,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  getU32Decoder,
  getU64Decoder,
  type Instruction,
  isSome,
  verifySignature,
} from "@solana/kit";
import {
  cancelCompose,
  cctpBurnDecoder,
  evmWord,
  mintHook,
  oftSendDecoder,
  redeemCompose,
} from "./abi";
import { SdpPlumeError } from "./errors";
import { assertPlumeOperationActive } from "./operation";

// biome-ignore lint/security/noSecrets: canonical associated-token program address.
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM = "11111111111111111111111111111111";
const COMPUTE = "ComputeBudget111111111111111111111111111111";
const TOKEN = SPL_TOKEN_PROGRAMS["spl-token"];
const BURN_DISCRIMINATOR = Uint8Array.of(111, 245, 62, 131, 204, 108, 223, 155);
const SEND_DISCRIMINATOR = Uint8Array.of(102, 251, 20, 187, 65, 75, 12, 69);
const lookupCache = new WeakMap<
  SolanaRpc,
  Map<string, { expires: number; addresses: AddressesByLookupTableAddress }>
>();

function refuse(message: string): never {
  throw new SdpPlumeError("VAULT_UNREADABLE", message);
}
function account(instruction: Instruction, index: number): string {
  const value = instruction.accounts?.[index];
  if (value === undefined) return refuse("Plume instruction is missing a required account");
  return value.address;
}
function requireEqual(actual: string | bigint | number, expected: string | bigint | number): void {
  if (actual !== expected) refuse("Plume transaction differs from the approved request");
}

async function lookupAddresses(
  rpc: SolanaRpc,
  table: string
): Promise<AddressesByLookupTableAddress> {
  let cache = lookupCache.get(rpc);
  if (!cache) {
    cache = new Map();
    lookupCache.set(rpc, cache);
  }
  const cached = cache.get(table);
  if (cached && cached.expires > Date.now()) return cached.addresses;
  assertPlumeOperationActive();
  const addresses = await fetchAddressesForLookupTables([address(table)], rpc);
  cache.set(table, { addresses, expires: Date.now() + 60_000 });
  return addresses;
}

export interface PlumePlanInput {
  vault: PlumeVaultDeployment;
  owner: string;
  feePayer: string;
  depositMint: string;
  atoms: bigint;
  canonicalAmount: string;
  mode: "mint" | "standard" | "instant" | "cancel";
  originalComposer?: string;
  transactionBase64: string;
}

/** Treat the builder as an untrusted instruction source, not a signing authority.
 * Every owner debit, route, receiver and amount is checked against the request.
 * Only the CCTP mint's two protocol-account signers may be pre-signed.
 */
export async function admitPlumeTransaction(
  rpc: SolanaRpc,
  input: PlumePlanInput
): Promise<EarnVaultTransactionPlan> {
  const bytes = Buffer.from(input.transactionBase64, "base64");
  if (bytes.length > 1232 || bytes.length === 0) refuse("Invalid Plume transaction size");
  const transaction = getTransactionDecoder().decode(bytes);
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  if (compiled.version !== 0) refuse("Plume must return a versioned transaction");
  requireEqual(compiled.staticAccounts[0], input.feePayer);
  const lookups = compiled.addressTableLookups === undefined ? [] : compiled.addressTableLookups;
  for (const table of lookups) requireEqual(table.lookupTableAddress, input.vault.lookupTable);
  const tables = lookups.length === 0 ? {} : await lookupAddresses(rpc, input.vault.lookupTable);
  // Read AFTER the builder. This lifetime bounds every earlier valid recent blockhash.
  // It is intentionally conservative: it cannot expire an unbroadcast transaction early.
  assertPlumeOperationActive();
  const latest = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  assertPlumeOperationActive();
  const valid = await rpc
    .isBlockhashValid(blockhash(compiled.lifetimeToken), {
      commitment: "confirmed",
      minContextSlot: latest.context.slot,
    })
    .send();
  if (!valid.value) refuse("Plume transaction expired; rebuild before signing");
  const message = decompileTransactionMessage(compiled, {
    addressesByLookupTableAddress: tables,
    lastValidBlockHeight: latest.value.lastValidBlockHeight,
  });
  const [usdcAta, shareAta] = await Promise.all([
    deriveAssociatedTokenAddress(input.owner, input.depositMint, TOKEN),
    deriveAssociatedTokenAddress(input.owner, input.vault.shareMint, TOKEN),
  ]);
  const { movementInstruction: ix, createsShareAccount } = selectMovementInstruction(
    message.instructions,
    input,
    usdcAta,
    shareAta
  );
  if (ix.data === undefined) refuse("Missing money instruction data");
  const additionalSigners = input.mode === "mint" ? admitMint(ix, ix.data, input, usdcAta) : [];
  if (input.mode !== "mint") admitRedemption(ix, ix.data, input, usdcAta, shareAta);
  await verifyProtocolSignatures(transaction, input, additionalSigners);

  const plan: EarnVaultTransactionPlan = {
    cluster: input.vault.cluster,
    assetIdentity: { depositTokenMint: input.depositMint, shareMint: input.vault.shareMint },
    instructions: message.instructions.map((i) => ({
      programAddress: i.programAddress,
      accounts: (i.accounts ?? []).map((a) => ({ address: a.address, role: a.role })),
      data: Buffer.from(i.data ?? new Uint8Array()).toString("base64"),
    })),
    lookupTables: lookups.map((t) => t.lookupTableAddress),
    createsShareAccount,
    accepted:
      input.mode === "mint"
        ? { amount: input.canonicalAmount }
        : {
            shares: input.canonicalAmount,
            redemptionMode: input.mode === "cancel" ? undefined : input.mode,
          },
  };
  if (additionalSigners.length > 0)
    plan.providerTransaction = {
      transactionBase64: bytes.toString("base64"),
      additionalSigners,
      lastValidBlockHeight: latest.value.lastValidBlockHeight.toString(),
    };
  return plan;
}

function selectMovementInstruction(
  instructions: readonly Instruction[],
  input: PlumePlanInput,
  usdcAta: string,
  shareAta: string
) {
  let movementInstruction: Instruction | undefined;
  let createsShareAccount = false;
  for (const instruction of instructions) {
    if (instruction.data === undefined) refuse("Plume instruction has no data");
    switch (instruction.programAddress) {
      case COMPUTE: {
        admitComputeInstruction(instruction.data);
        break;
      }
      case ATA: {
        if (instruction.data.length !== 1 || instruction.data[0] !== 1)
          refuse("Plume must use idempotent ATA creation");
        const mint = account(instruction, 3);
        if (mint !== input.depositMint && mint !== input.vault.shareMint)
          refuse("Unexpected Plume ATA mint");
        requireEqual(account(instruction, 0), input.feePayer);
        requireEqual(account(instruction, 1), mint === input.depositMint ? usdcAta : shareAta);
        requireEqual(account(instruction, 2), input.owner);
        requireEqual(account(instruction, 4), SYSTEM);
        requireEqual(account(instruction, 5), TOKEN);
        createsShareAccount ||= mint === input.vault.shareMint;
        break;
      }
      case PLUME_PROGRAMS.tokenMessenger:
      case PLUME_PROGRAMS.oft:
        if (movementInstruction !== undefined) refuse("Plume returned multiple money instructions");
        movementInstruction = instruction;
        break;
      default:
        refuse("Plume returned an unapproved instruction program");
    }
  }
  if (movementInstruction === undefined || movementInstruction.data === undefined)
    refuse("Plume transaction has no money instruction");
  return { movementInstruction, createsShareAccount };
}
function admitMint(
  ix: Instruction,
  data: NonNullable<Instruction["data"]>,
  input: PlumePlanInput,
  usdcAta: string
): string[] {
  requireEqual(ix.programAddress, PLUME_PROGRAMS.tokenMessenger);
  const [burn, burnEnd] = cctpBurnDecoder.read(data, 0);
  if (burnEnd !== data.length) refuse("Trailing CCTP instruction data");
  if (!bytesEqual(burn.discriminator, BURN_DISCRIMINATOR)) refuse("Unexpected CCTP instruction");
  requireEqual(burn.amount, input.atoms);
  requireEqual(burn.domain, PLUME_CCTP_DOMAIN);
  if (
    !bytesEqual(burn.recipient, evmWord(input.vault.relayer)) ||
    !bytesEqual(burn.caller, evmWord(input.vault.relayer))
  )
    refuse("Unexpected CCTP destination");
  // SDP's admission ceiling is 1% of the input. The API still quotes Circle's live fee.
  if (burn.maxFee >= burn.amount || burn.maxFee * 10_000n > burn.amount * 100n)
    refuse("Plume bridge fee exceeds policy");
  if (burn.finality !== 2000) refuse("Unexpected Plume CCTP finality policy");
  if (
    !bytesEqual(burn.hook, mintHook(input.vault, input.owner, usdcAta, burn.amount - burn.maxFee))
  )
    refuse("Plume mint hook differs from the approved vault and receiver");
  requireEqual(account(ix, 0), input.owner);
  requireEqual(account(ix, 3), usdcAta);
  requireEqual(account(ix, 10), input.depositMint);
  requireEqual(account(ix, 12), PLUME_PROGRAMS.messageTransmitter);
  requireEqual(account(ix, 13), PLUME_PROGRAMS.tokenMessenger);
  requireEqual(account(ix, 14), TOKEN);
  requireEqual(account(ix, 15), SYSTEM);
  requireEqual(account(ix, 17), PLUME_PROGRAMS.tokenMessenger);
  const additionalSigners = [account(ix, 1), account(ix, 11)];
  if (
    new Set([input.owner, input.feePayer, ...additionalSigners]).size !==
    (input.owner === input.feePayer ? 3 : 4)
  )
    refuse("Invalid Plume protocol signer identities");
  return additionalSigners;
}
function admitRedemption(
  ix: Instruction,
  data: NonNullable<Instruction["data"]>,
  input: PlumePlanInput,
  usdcAta: string,
  shareAta: string
): void {
  requireEqual(ix.programAddress, PLUME_PROGRAMS.oft);
  const [send, sendEnd] = oftSendDecoder.read(data, 0);
  if (sendEnd !== data.length) refuse("Trailing OFT instruction data");
  if (!bytesEqual(send.discriminator, SEND_DISCRIMINATOR)) refuse("Unexpected OFT instruction");
  requireEqual(send.dstEid, PLUME_ENDPOINT_ID);
  requireEqual(send.amount, input.atoms);
  requireEqual(send.minimum, input.atoms);
  requireEqual(send.lzTokenFee, 0n);
  if (send.nativeFee > 100_000_000n) refuse("Plume native bridge fee exceeds policy");
  const composer =
    input.mode === "cancel" ? input.originalComposer : input.vault.redemptionComposer;
  if (composer === undefined || !bytesEqual(send.to, evmWord(composer)) || !isSome(send.compose))
    refuse("Unexpected Plume redemption route");
  const plumeAtoms =
    input.atoms /
    10n ** BigInt(Math.max(0, input.vault.shareDecimals - input.vault.plumeShareDecimals));
  if (input.mode === "cancel") {
    if (send.compose.value.length !== 416) refuse("Invalid cancellation message");
    const returnValue = BigInt(
      `0x${Buffer.from(send.compose.value).subarray(32, 64).toString("hex")}`
    );
    if (
      !bytesEqual(send.compose.value, cancelCompose(usdcAta, returnValue)) &&
      !bytesEqual(send.compose.value, cancelCompose(input.owner, returnValue))
    )
      refuse("Unexpected cancellation receiver or amount");
  } else if (
    !bytesEqual(
      send.compose.value,
      redeemCompose(usdcAta, plumeAtoms, input.mode === "instant" ? "instant" : "standard")
    )
  )
    refuse("Unexpected Plume redemption receiver or mode");
  requireEqual(account(ix, 0), input.owner);
  requireEqual(account(ix, 2), input.vault.oftStore);
  requireEqual(account(ix, 3), shareAta);
  requireEqual(account(ix, 4), input.vault.tokenEscrow);
  requireEqual(account(ix, 5), input.vault.shareMint);
  requireEqual(account(ix, 6), TOKEN);
  requireEqual(account(ix, 8), PLUME_PROGRAMS.oft);
}
async function verifyProtocolSignatures(
  transaction: ReturnType<ReturnType<typeof getTransactionDecoder>["decode"]>,
  input: PlumePlanInput,
  additionalSigners: string[]
) {
  const expected = new Set([input.feePayer, input.owner, ...additionalSigners]);
  if (Object.keys(transaction.signatures).length !== expected.size)
    refuse("Plume returned unexpected signers");
  for (const [signer, sig] of Object.entries(transaction.signatures)) {
    if (!expected.has(signer)) refuse("Plume returned an unexpected signer");
    if (additionalSigners.includes(signer)) {
      if (
        sig === null ||
        !(await verifySignature(
          await getPublicKeyFromAddress(address(signer)),
          sig,
          transaction.messageBytes
        ))
      )
        refuse("Invalid Plume protocol signature");
    } else if (sig !== null) refuse("Plume must not sign for the owner or fee payer");
  }
}

function admitComputeInstruction(data: NonNullable<Instruction["data"]>): void {
  if (data[0] === 2 && data.length === 5) {
    if (getU32Decoder().decode(data, 1) > 1_400_000) refuse("Plume compute limit exceeds policy");
  } else if (data[0] === 3 && data.length === 9) {
    if (getU64Decoder().decode(data, 1) > 1_000_000n) refuse("Plume priority fee exceeds policy");
  } else refuse("Unsupported Plume compute instruction");
}
