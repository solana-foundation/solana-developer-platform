import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  DEFAULT_TREE_ADDRESS,
  SHIELDED_POOL_PROGRAM_ID,
  SOL_INTERFACE,
  SPL_TOKEN_PROGRAM_ID,
} from "@heliuslabs/zolana/interface";
import { HeliusRingsError } from "@sdp/helius-rings";
import {
  type Address,
  address,
  getAddressEncoder,
  getBase58Decoder,
  getBase58Encoder,
  getBase64Codec,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getProgramDerivedAddress,
  getTransactionDecoder,
  getTransactionEncoder,
} from "@solana/kit";
import {
  getSetComputeUnitLimitInstruction,
  MAX_COMPUTE_UNIT_LIMIT,
} from "@solana-program/compute-budget";
import { PROTOCOL_NATIVE_MINT, protocolMint } from "./flows/mint.js";

const SAFE_MESSAGE = "the unsigned Rings transaction does not match the approved operation";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const DEPOSIT_TAG = 11;
const RING_DEPOSIT_TAG = 14;
const TRANSACT_TAG = 12;
/** Byte 0 of a ring program's transact instruction (its own dispatch, not the pool's). */
const RING_TRANSACT_TAG = 3;
/** zolana's CUSTOM_RING_PROOF_LENGTH: a(32) || b(64) || c(32) || commitment(32) || commitmentPok(32). */
const RING_PROOF_LENGTH = 192;
const U64_MAX = 0xffff_ffff_ffff_ffffn;
const ZERO_32 = new Uint8Array(32);
const COMPUTE_LIMIT = getSetComputeUnitLimitInstruction({ units: MAX_COMPUTE_UNIT_LIMIT });
const addressEncoder = getAddressEncoder();
const textEncoder = new TextEncoder();

export type OuterTransactionPolicyIntent =
  | Readonly<{
      opType: "shield";
      mint: string;
      amountRaw: string;
      expectedShieldedAddress: string;
      /**
       * Present when the operation was pinned to a project's custom ring at
       * prepare time: the deposit must then be that ring's own tag-14
       * instruction rather than a plain shielded-pool deposit.
       */
      ringProgramId?: string;
    }>
  | Readonly<{
      opType: "transfer_registered";
      mint: string;
      amountRaw: string;
      /**
       * Present when the spend was pinned to a custom ring at prepare time;
       * always arrives together with `ringLookupTable`. The transact must then
       * be the ring program's own tag-3 instruction, ALT-compressed over that
       * table.
       */
      ringProgramId?: string;
      ringLookupTable?: string;
    }>
  | Readonly<{
      opType: "withdraw";
      mint: string;
      amountRaw: string;
      to: string;
      /** Same contract as the transfer arm's ring pair. */
      ringProgramId?: string;
      ringLookupTable?: string;
    }>;

/** Kit-neutral DTO accepted at the SDK/API major-version boundary. */
export interface OuterTransactionPolicyInput {
  readonly outerUnsignedTxBase64: string;
  readonly owner: string;
  readonly intent: OuterTransactionPolicyIntent;
  /** Defaults to Zolana's pinned v0.1.1-alpha tree. */
  readonly expectedTree?: string;
}

interface DecodedInstruction {
  readonly programAddressIndex: number;
  readonly accountIndices?: readonly number[];
  readonly data?: Uint8Array;
}

/** Kit's compiled v0 lookup entry; indexes point into the on-chain table's address vector. */
interface DecodedAddressTableLookup {
  readonly lookupTableAddress: string;
  readonly writableIndexes: readonly number[];
  readonly readonlyIndexes: readonly number[];
}

interface DecodedMessage {
  readonly version: 0 | "legacy";
  readonly header: Readonly<{
    numSignerAccounts: number;
    numReadonlySignerAccounts: number;
    numReadonlyNonSignerAccounts: number;
  }>;
  readonly staticAccounts: readonly string[];
  readonly instructions: readonly DecodedInstruction[];
  readonly addressTableLookups?: readonly DecodedAddressTableLookup[];
}

interface AccountExpectation {
  readonly address: string;
  readonly signer?: boolean;
  readonly writable: boolean;
}

interface ParsedDeposit {
  readonly assetKind: "sol" | "spl";
  readonly splInterfaceBump?: number;
  readonly viewTag: Uint8Array;
  readonly recipientOwnerHash: Uint8Array;
  readonly amount: bigint;
}

interface ParsedRingDeposit {
  readonly assetKind: "sol" | "spl";
  readonly splInterfaceBump?: number;
  readonly viewTag: Uint8Array;
  readonly amount: bigint;
}

interface ParsedInterfaceTransfer {
  readonly tag: number;
  readonly amount: bigint;
}

function mismatch(): never {
  throw new Error("policy mismatch");
}

function equalBytes(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function requiredAddress(value: string): Address {
  return address(value);
}

function requiredAmount(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) mismatch();
  const amount = BigInt(value);
  if (amount <= 0n || amount > U64_MAX) mismatch();
  return amount;
}

function expectedOwnerHash(canonicalIdentity: string): Uint8Array {
  return decodedShieldedIdentity(canonicalIdentity).slice(0, 32);
}

/**
 * The recipient's viewing-key x-coordinate: the tail of the 65-byte identity
 * `owner_hash(32) || parity(1) || x(32)`, and exactly what the ring deposit
 * builder writes as the view tag.
 */
function expectedRingViewTag(canonicalIdentity: string): Uint8Array {
  return decodedShieldedIdentity(canonicalIdentity).slice(33, 65);
}

function decodedShieldedIdentity(canonicalIdentity: string): Uint8Array {
  const bytes = new Uint8Array(getBase58Encoder().encode(canonicalIdentity));
  if (bytes.length !== 65 || getBase58Decoder().decode(bytes) !== canonicalIdentity) {
    mismatch();
  }
  return bytes;
}

class StrictReader {
  readonly #input: Uint8Array;
  #offset = 0;

  constructor(input: Uint8Array) {
    this.#input = input;
  }

  u8(): number {
    return this.bytes(1)[0] as number;
  }

  u16(): number {
    const value = this.bytes(2);
    return (value[0] as number) | ((value[1] as number) << 8);
  }

  u64(): bigint {
    const value = this.bytes(8);
    let result = 0n;
    for (let index = value.length - 1; index >= 0; index -= 1) {
      result = (result << 8n) | BigInt(value[index] as number);
    }
    return result;
  }

  bool(): boolean {
    const value = this.u8();
    if (value !== 0 && value !== 1) mismatch();
    return value === 1;
  }

  bytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || this.#offset + length > this.#input.length) {
      mismatch();
    }
    const result = this.#input.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return result;
  }

  done(): void {
    if (this.#offset !== this.#input.length) mismatch();
  }
}

function parseDeposit(data: Uint8Array): ParsedDeposit {
  const reader = new StrictReader(data);
  if (reader.u8() !== DEPOSIT_TAG || reader.u8() !== 1) mismatch();

  const kind = reader.u8();
  let assetKind: ParsedDeposit["assetKind"];
  let splInterfaceBump: number | undefined;
  if (kind === 0) {
    assetKind = "sol";
  } else if (kind === 1) {
    assetKind = "spl";
    splInterfaceBump = reader.u8();
  } else {
    return mismatch();
  }

  if (reader.u8() !== 1 || reader.u8() !== 0) mismatch();
  const viewTag = reader.bytes(32);
  const recipientOwnerHash = reader.bytes(32);
  reader.bytes(32); // random blinding
  const amount = reader.u64();
  // The enabled shield builder supplies neither UTXO data nor a memo.
  if (reader.bool() || reader.bool()) mismatch();
  reader.done();

  return {
    assetKind,
    ...(splInterfaceBump === undefined ? {} : { splInterfaceBump }),
    viewTag,
    recipientOwnerHash,
    amount,
  };
}

/**
 * The tag-14 payload `buildRingDepositTransaction` emits: single asset, single
 * deposit, no UTXO data hash, an all-zero ring data hash, and the note
 * ciphertext behind a u16-length vector.
 *
 * Unlike the plain deposit there is no clear recipient owner hash to check:
 * the ring note commits to `Poseidon(owner_hash, blinding)` with the blinding
 * random and shipped only inside the ciphertext, so it is opaque here by
 * design. The view tag is the recipient's viewing-key x-coordinate, which the
 * intent's shielded address carries — the strongest recipient bind these
 * bytes admit.
 */
function parseRingDeposit(data: Uint8Array): ParsedRingDeposit {
  const reader = new StrictReader(data);
  if (reader.u8() !== RING_DEPOSIT_TAG || reader.u8() !== 1) mismatch();

  const kind = reader.u8();
  let assetKind: ParsedRingDeposit["assetKind"];
  let splInterfaceBump: number | undefined;
  if (kind === 0) {
    assetKind = "sol";
  } else if (kind === 1) {
    assetKind = "spl";
    splInterfaceBump = reader.u8();
  } else {
    return mismatch();
  }

  if (reader.u8() !== 1 || reader.u8() !== 0) mismatch();
  const viewTag = reader.bytes(32);
  reader.bytes(32); // ownerUtxoHash: Poseidon commitment, opaque by design
  const amount = reader.u64();
  // The builder never sets a UTXO data hash, and pins the ring data hash to
  // zero; a nonzero value would bind ring data custody never saw.
  if (reader.bool() || !equalBytes(reader.bytes(32), ZERO_32)) mismatch();
  reader.bytes(33); // encrypted.txViewingPublicKey (ephemeral)
  reader.bytes(16); // encrypted.salt
  reader.bytes(reader.u16()); // encrypted.ciphertext
  reader.done();

  return {
    assetKind,
    ...(splInterfaceBump === undefined ? {} : { splInterfaceBump }),
    viewTag,
    amount,
  };
}

function parsePublicInterfaceTransfers(data: Uint8Array): readonly ParsedInterfaceTransfer[] {
  const reader = new StrictReader(data);
  if (reader.u8() !== TRANSACT_TAG) mismatch();
  return parseTransactBody(reader);
}

/**
 * The ring program's transact: `tag(3) || proof(192) || transact body`. The
 * body is byte-compatible with the pool transact's — there is no inner
 * discriminator; the ring tag enters only the proof's external-data hash.
 * The custom-ring proof is opaque here and verified by the ring program on
 * chain.
 */
function parseRingTransact(data: Uint8Array): readonly ParsedInterfaceTransfer[] {
  const reader = new StrictReader(data);
  if (reader.u8() !== RING_TRANSACT_TAG) mismatch();
  reader.bytes(RING_PROOF_LENGTH);
  return parseTransactBody(reader);
}

function parseTransactBody(reader: StrictReader): readonly ParsedInterfaceTransfer[] {
  reader.u64(); // opaque expiry
  reader.bytes(32); // private transaction hash
  reader.bytes(5); // opaque circuit kind, input/output counts and public-asset slots
  reader.bytes(33); // transaction viewing public key
  reader.bytes(16); // salt
  reader.bytes(128); // proof
  const inputCount = reader.u8();
  reader.bytes(inputCount * 36);

  const interfaceTransferCount = reader.u8();
  const interfaceTransfers: ParsedInterfaceTransfer[] = [];
  for (let index = 0; index < interfaceTransferCount; index += 1) {
    const tag = reader.u8();
    if (tag > 3) mismatch();
    const amount = reader.u64();
    if (amount === 0n) mismatch();
    if (tag === 2 || tag === 3) reader.u8();
    interfaceTransfers.push({ tag, amount });
  }

  // Custody's parsing boundary ends at the public settlement section. Expiry,
  // circuit/proof metadata and the remaining private zone/UTXO/output/
  // ciphertext/message tail are Zolana/prover/program concerns. We traverse
  // only enough opaque prefix and variable-input bytes to locate this public
  // effect safely.
  return interfaceTransfers;
}

function accountRole(
  message: DecodedMessage,
  index: number
): Readonly<{ signer: boolean; writable: boolean }> {
  const { numSignerAccounts, numReadonlySignerAccounts, numReadonlyNonSignerAccounts } =
    message.header;
  if (index < 0 || index >= message.staticAccounts.length) mismatch();

  const signer = index < numSignerAccounts;
  const writable = signer
    ? index < numSignerAccounts - numReadonlySignerAccounts
    : index < message.staticAccounts.length - numReadonlyNonSignerAccounts;
  return { signer, writable };
}

function resolvedInstruction(
  message: DecodedMessage,
  instruction: DecodedInstruction
): Readonly<{
  program: string;
  accounts: readonly Readonly<{ address: string; signer: boolean; writable: boolean }>[];
  data: Uint8Array;
}> {
  const program = message.staticAccounts[instruction.programAddressIndex];
  if (!program) mismatch();
  const accounts = (instruction.accountIndices ?? []).map((index) => {
    const accountAddress = message.staticAccounts[index];
    if (!accountAddress) mismatch();
    return { address: accountAddress, ...accountRole(message, index) };
  });
  return { program, accounts, data: instruction.data ?? new Uint8Array() };
}

function expectAccounts(
  actual: readonly Readonly<{ address: string; signer: boolean; writable: boolean }>[],
  expected: readonly AccountExpectation[]
): void {
  if (actual.length !== expected.length) mismatch();
  for (let index = 0; index < expected.length; index += 1) {
    const account = actual[index];
    const wanted = expected[index];
    if (
      !account ||
      !wanted ||
      account.address !== wanted.address ||
      account.writable !== wanted.writable ||
      (wanted.signer !== undefined && account.signer !== wanted.signer)
    ) {
      mismatch();
    }
  }
}

function expectStaticAccounts(message: DecodedMessage, expected: readonly string[]): void {
  const uniqueExpected = new Set(expected);
  const actual = new Set(message.staticAccounts);
  if (
    actual.size !== message.staticAccounts.length ||
    actual.size !== uniqueExpected.size ||
    [...actual].some((entry) => !uniqueExpected.has(entry))
  ) {
    mismatch();
  }
}

function validateEnvelope(
  message: DecodedMessage,
  signatures: Record<string, unknown>,
  owner: Address
): void {
  if (
    message.version !== 0 ||
    (message.addressTableLookups?.length ?? 0) !== 0 ||
    message.header.numSignerAccounts !== 1 ||
    message.header.numReadonlySignerAccounts !== 0 ||
    message.staticAccounts[0] !== owner
  ) {
    mismatch();
  }

  const entries = Object.entries(signatures);
  if (entries.length !== 1 || entries[0]?.[0] !== owner || entries[0]?.[1] !== null) {
    mismatch();
  }
}

async function splAccounts(
  owner: Address,
  mint: Address
): Promise<
  Readonly<{
    sourceTokenAccount: Address;
    splInterface: Address;
    bump: number;
  }>
> {
  const [sourceTokenAccount] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ID,
    seeds: [
      addressEncoder.encode(owner),
      addressEncoder.encode(SPL_TOKEN_PROGRAM_ID),
      addressEncoder.encode(mint),
    ],
  });
  const [splInterface, bump] = await getProgramDerivedAddress({
    programAddress: SHIELDED_POOL_PROGRAM_ID,
    seeds: [textEncoder.encode("spl_asset_vault"), addressEncoder.encode(mint)],
  });
  return { sourceTokenAccount, splInterface, bump };
}

/** The ring program's own signer PDA; the one account a ring deposit adds. */
async function ringAuthAddress(ringProgramId: Address): Promise<Address> {
  const [derived] = await getProgramDerivedAddress({
    programAddress: ringProgramId,
    seeds: [textEncoder.encode("ring_auth")],
  });
  return derived;
}

/**
 * The exact contents of a ring's address lookup table, derived locally with no
 * RPC and no zolana import. Sound only through a chain of custody this SDK
 * enforces end to end: the bring-up gate asserts the extend instruction's
 * address vector byte-equals this list, custody is the table's authority, and
 * custody never signs another extend (the bring-up gate refuses anything
 * else). Order is load-bearing — message lookups index into it. Mirrors
 * zolana's `ringLookupTableAddresses` with inputTree === outputTree deduped; a
 * unit test pins the two together so upstream drift breaks the build instead
 * of custody.
 *
 * Exported for one other caller: the bring-up gate in `provision-ring.ts`,
 * which refuses to let custody sign an extend carrying any other address
 * vector — the second half of the chain of custody above.
 */
export async function expectedRingTable(ring: Address, tree: Address): Promise<readonly string[]> {
  const [ringConfig] = await getProgramDerivedAddress({
    programAddress: ring,
    seeds: [textEncoder.encode("config")],
  });
  return [
    ringConfig,
    tree,
    SHIELDED_POOL_PROGRAM_ID,
    SYSTEM_PROGRAM,
    await ringAuthAddress(ring),
    ring,
    COMPUTE_LIMIT.programAddress,
  ];
}

/**
 * The ring analog of `validateEnvelope`: same version, signer and signature
 * checks, but exactly one address-table lookup and only over the ring's own
 * persisted table. Every index must be unique and land inside the expected
 * table — an address named in `writableIndexes` is writable in the signed
 * transaction even if no instruction references it, so the index lists are
 * part of the account universe custody signs.
 */
function validateRingSpendEnvelope(
  message: DecodedMessage,
  signatures: Record<string, unknown>,
  owner: Address,
  ringLookupTable: Address,
  tableLength: number
): DecodedAddressTableLookup {
  if (
    message.version !== 0 ||
    message.header.numSignerAccounts !== 1 ||
    message.header.numReadonlySignerAccounts !== 0 ||
    message.staticAccounts[0] !== owner
  ) {
    mismatch();
  }

  const entries = Object.entries(signatures);
  if (entries.length !== 1 || entries[0]?.[0] !== owner || entries[0]?.[1] !== null) {
    mismatch();
  }

  const lookups = message.addressTableLookups ?? [];
  const lookup = lookups[0];
  if (lookups.length !== 1 || !lookup || lookup.lookupTableAddress !== ringLookupTable) {
    mismatch();
  }
  const indexes = [...lookup.writableIndexes, ...lookup.readonlyIndexes];
  if (new Set(indexes).size !== indexes.length) mismatch();
  for (const index of indexes) {
    if (!Number.isInteger(index) || index < 0 || index >= tableLength) mismatch();
  }
  return lookup;
}

/**
 * Like `resolvedInstruction`, but over a v0 message's combined account space
 * `[statics..., writable lookups..., readonly lookups...]`, resolving lookup
 * indices against the locally derived expected table. The program address must
 * stay static: programs cannot be loaded through a lookup table.
 */
function resolvedRingInstruction(
  message: DecodedMessage,
  instruction: DecodedInstruction,
  lookup: DecodedAddressTableLookup,
  expectedTable: readonly string[]
): Readonly<{
  program: string;
  accounts: readonly Readonly<{ address: string; signer: boolean; writable: boolean }>[];
  data: Uint8Array;
}> {
  const program = message.staticAccounts[instruction.programAddressIndex];
  if (!program) mismatch();

  const statics = message.staticAccounts.length;
  const accounts = (instruction.accountIndices ?? []).map((index) => {
    if (index < statics) {
      const accountAddress = message.staticAccounts[index];
      if (!accountAddress) mismatch();
      return { address: accountAddress, ...accountRole(message, index) };
    }
    const writableOffset = index - statics;
    if (writableOffset < lookup.writableIndexes.length) {
      const accountAddress = expectedTable[lookup.writableIndexes[writableOffset] as number];
      if (!accountAddress) mismatch();
      return { address: accountAddress, signer: false, writable: true };
    }
    const readonlyOffset = writableOffset - lookup.writableIndexes.length;
    if (readonlyOffset >= lookup.readonlyIndexes.length) mismatch();
    const accountAddress = expectedTable[lookup.readonlyIndexes[readonlyOffset] as number];
    if (!accountAddress) mismatch();
    return { address: accountAddress, signer: false, writable: false };
  });
  return { program, accounts, data: instruction.data ?? new Uint8Array() };
}

/**
 * The lookup-list analog of `expectStaticAccounts`: what each index list loads
 * must be exactly the expected set — nothing extra rides along as writable.
 * Set equality suffices: the envelope made the indexes unique and the table's
 * seven addresses are distinct, so lengths plus membership pin both sides.
 */
function expectRingLookups(
  lookup: DecodedAddressTableLookup,
  expectedTable: readonly string[],
  expectedWritable: readonly string[],
  expectedReadonly: readonly string[]
): void {
  const check = (indexes: readonly number[], expected: readonly string[]) => {
    if (indexes.length !== expected.length) mismatch();
    const wanted = new Set(expected);
    for (const index of indexes) {
      const accountAddress = expectedTable[index];
      if (!accountAddress || !wanted.has(accountAddress)) mismatch();
    }
  };
  check(lookup.writableIndexes, expectedWritable);
  check(lookup.readonlyIndexes, expectedReadonly);
}

type RingSpendPolicyIntent = Extract<
  OuterTransactionPolicyIntent,
  { opType: "transfer_registered" } | { opType: "withdraw" }
>;

/**
 * A ring-bound spend: one compute instruction, then the ring program's own
 * tag-3 transact, ALT-compressed over the ring's persisted lookup table.
 *
 * What this gate can and cannot prove. It proves the right ring program, the
 * right tree, the pinned lookup table, the exact account universe (statics
 * plus both lookup lists), a single owner signature, and the public
 * settlement: none on a transfer, exactly the approved recipient and amount on
 * a withdraw. On a TRANSFER it cannot verify the recipient or amount — they
 * live inside encrypted outputs bound by the ring proof, and the auditor
 * message is ciphertext to custody. The default spend path binds those fields
 * pre-encryption in `validatePreparedTransferIntent`; ring spends never reach
 * it because the one-call ring builders do not expose the prepared transfer.
 * Accepted because the transaction is built in-process against the approved
 * persisted intent inside the same buildOperation call, and the transfer
 * recipient is a same-tenant wallet's ShieldedAddress loaded from custody
 * material.
 */
async function validateRingSpend(
  intent: RingSpendPolicyIntent & { ringProgramId: string },
  message: DecodedMessage,
  signatures: Record<string, unknown>,
  owner: Address,
  tree: Address
): Promise<void> {
  const ring = requiredAddress(intent.ringProgramId);
  // The service pins the table alongside the ring; one without the other is a
  // build this SDK never produced.
  if (intent.ringLookupTable === undefined) mismatch();
  const ringLookupTable = requiredAddress(intent.ringLookupTable);
  const expectedTable = await expectedRingTable(ring, tree);

  const lookup = validateRingSpendEnvelope(
    message,
    signatures,
    owner,
    ringLookupTable,
    expectedTable.length
  );

  if (message.instructions.length !== 2) mismatch();
  const computeProgram = validateComputeInstruction(
    message,
    message.instructions[0] as DecodedInstruction
  );
  const instruction = resolvedRingInstruction(
    message,
    message.instructions[1] as DecodedInstruction,
    lookup,
    expectedTable
  );
  if (instruction.program !== ring) mismatch();
  if (protocolMint(intent.mint) !== PROTOCOL_NATIVE_MINT) mismatch();
  const interfaceTransfers = parseRingTransact(instruction.data);

  const ringConfig = expectedTable[0] as string;
  const ringAuth = expectedTable[4] as string;
  const commonAccounts: AccountExpectation[] = [
    { address: owner, signer: true, writable: true },
    { address: ringConfig, signer: false, writable: false },
    // The payer appears a second time in the ring transact's account list.
    { address: owner, signer: true, writable: true },
    { address: tree, signer: false, writable: true },
    { address: tree, signer: false, writable: true },
    { address: SHIELDED_POOL_PROGRAM_ID, signer: false, writable: false },
    { address: SYSTEM_PROGRAM, signer: false, writable: false },
    { address: ringAuth, signer: false, writable: false },
  ];
  const lookupWritable = [tree as string];
  const lookupReadonly = [ringConfig, SHIELDED_POOL_PROGRAM_ID as string, SYSTEM_PROGRAM, ringAuth];

  if (intent.opType === "transfer_registered") {
    // Well-formedness only; see the gap note above — a ring transfer's
    // recipient and amount cannot be re-derived from these bytes.
    requiredAddress(intent.mint);
    requiredAmount(intent.amountRaw);
    if (interfaceTransfers.length !== 0) mismatch();
    expectAccounts(instruction.accounts, commonAccounts);
    expectStaticAccounts(message, [owner, ring, computeProgram]);
    expectRingLookups(lookup, expectedTable, lookupWritable, lookupReadonly);
    return;
  }

  const amount = requiredAmount(intent.amountRaw);
  const recipient = requiredAddress(intent.to);
  const settlement = interfaceTransfers[0];
  if (interfaceTransfers.length !== 1 || settlement?.tag !== 1 || settlement.amount !== amount) {
    mismatch();
  }
  expectAccounts(instruction.accounts, [
    ...commonAccounts,
    { address: SOL_INTERFACE, signer: false, writable: true },
    // If recipient === owner, Solana correctly merges this with the signer role.
    { address: recipient, writable: true },
  ]);
  expectStaticAccounts(message, [owner, SOL_INTERFACE, recipient, ring, computeProgram]);
  expectRingLookups(lookup, expectedTable, lookupWritable, lookupReadonly);
}

async function validateRingShield(
  intent: Extract<OuterTransactionPolicyIntent, { opType: "shield" }> & { ringProgramId: string },
  message: DecodedMessage,
  owner: Address,
  tree: Address
): Promise<void> {
  if (message.instructions.length !== 1) mismatch();
  const instruction = resolvedInstruction(message, message.instructions[0] as DecodedInstruction);
  const ring = requiredAddress(intent.ringProgramId);
  if (instruction.program !== ring) mismatch();

  const amount = requiredAmount(intent.amountRaw);
  const viewTag = expectedRingViewTag(intent.expectedShieldedAddress);
  const deposit = parseRingDeposit(instruction.data);
  if (deposit.amount !== amount || !equalBytes(deposit.viewTag, viewTag)) mismatch();

  const ringAuth = await ringAuthAddress(ring);
  const protocolAsset = protocolMint(intent.mint);
  if (protocolAsset === PROTOCOL_NATIVE_MINT) {
    if (deposit.assetKind !== "sol") mismatch();
    expectAccounts(instruction.accounts, [
      { address: tree, signer: false, writable: true },
      { address: owner, signer: true, writable: true },
      // The ring program signs this account inside its CPI to the pool.
      { address: ringAuth, signer: false, writable: false },
      { address: SHIELDED_POOL_PROGRAM_ID, signer: false, writable: false },
      { address: SYSTEM_PROGRAM, signer: false, writable: false },
      { address: SOL_INTERFACE, signer: false, writable: true },
    ]);
    expectStaticAccounts(message, [
      owner,
      tree,
      ring,
      ringAuth,
      SHIELDED_POOL_PROGRAM_ID,
      SYSTEM_PROGRAM,
      SOL_INTERFACE,
    ]);
    return;
  }

  if (deposit.assetKind !== "spl") mismatch();
  const derived = await splAccounts(owner, address(protocolAsset));
  if (deposit.splInterfaceBump !== derived.bump) mismatch();
  expectAccounts(instruction.accounts, [
    { address: tree, signer: false, writable: true },
    { address: owner, signer: true, writable: true },
    { address: ringAuth, signer: false, writable: false },
    { address: SHIELDED_POOL_PROGRAM_ID, signer: false, writable: false },
    { address: SPL_TOKEN_PROGRAM_ID, signer: false, writable: false },
    { address: protocolAsset, signer: false, writable: false },
    { address: derived.sourceTokenAccount, signer: false, writable: true },
    { address: derived.splInterface, signer: false, writable: true },
  ]);
  expectStaticAccounts(message, [
    owner,
    tree,
    ring,
    ringAuth,
    SHIELDED_POOL_PROGRAM_ID,
    SPL_TOKEN_PROGRAM_ID,
    protocolAsset,
    derived.sourceTokenAccount,
    derived.splInterface,
  ]);
}

async function validateShield(
  input: OuterTransactionPolicyInput,
  message: DecodedMessage,
  owner: Address,
  tree: Address
): Promise<void> {
  if (input.intent.opType !== "shield" || message.instructions.length !== 1) mismatch();
  if (input.intent.ringProgramId !== undefined) {
    await validateRingShield(
      { ...input.intent, ringProgramId: input.intent.ringProgramId },
      message,
      owner,
      tree
    );
    return;
  }
  const instruction = resolvedInstruction(message, message.instructions[0] as DecodedInstruction);
  if (instruction.program !== SHIELDED_POOL_PROGRAM_ID) mismatch();

  const amount = requiredAmount(input.intent.amountRaw);
  const ownerHash = expectedOwnerHash(input.intent.expectedShieldedAddress);
  const deposit = parseDeposit(instruction.data);
  if (
    deposit.amount !== amount ||
    !equalBytes(deposit.viewTag, new Uint8Array(addressEncoder.encode(owner))) ||
    !equalBytes(deposit.recipientOwnerHash, ownerHash)
  ) {
    mismatch();
  }

  const protocolAsset = protocolMint(input.intent.mint);
  if (protocolAsset === PROTOCOL_NATIVE_MINT) {
    if (deposit.assetKind !== "sol") mismatch();
    expectAccounts(instruction.accounts, [
      { address: tree, signer: false, writable: true },
      { address: owner, signer: true, writable: true },
      { address: SHIELDED_POOL_PROGRAM_ID, signer: false, writable: false },
      { address: SYSTEM_PROGRAM, signer: false, writable: false },
      { address: SOL_INTERFACE, signer: false, writable: true },
    ]);
    expectStaticAccounts(message, [
      owner,
      tree,
      SHIELDED_POOL_PROGRAM_ID,
      SYSTEM_PROGRAM,
      SOL_INTERFACE,
    ]);
    return;
  }

  if (deposit.assetKind !== "spl") mismatch();
  const derived = await splAccounts(owner, address(protocolAsset));
  if (deposit.splInterfaceBump !== derived.bump) mismatch();
  expectAccounts(instruction.accounts, [
    { address: tree, signer: false, writable: true },
    { address: owner, signer: true, writable: true },
    { address: SHIELDED_POOL_PROGRAM_ID, signer: false, writable: false },
    { address: SPL_TOKEN_PROGRAM_ID, signer: false, writable: false },
    { address: protocolAsset, signer: false, writable: false },
    { address: derived.sourceTokenAccount, signer: false, writable: true },
    { address: derived.splInterface, signer: false, writable: true },
  ]);
  expectStaticAccounts(message, [
    owner,
    tree,
    SHIELDED_POOL_PROGRAM_ID,
    SPL_TOKEN_PROGRAM_ID,
    protocolAsset,
    derived.sourceTokenAccount,
    derived.splInterface,
  ]);
}

function validateComputeInstruction(
  message: DecodedMessage,
  instruction: DecodedInstruction
): string {
  const resolved = resolvedInstruction(message, instruction);
  const programRole = accountRole(message, instruction.programAddressIndex);
  if (
    resolved.program !== COMPUTE_LIMIT.programAddress ||
    programRole.signer ||
    programRole.writable ||
    resolved.accounts.length !== 0 ||
    !equalBytes(resolved.data, COMPUTE_LIMIT.data as Uint8Array)
  ) {
    mismatch();
  }
  return resolved.program;
}

function validateSpend(
  input: OuterTransactionPolicyInput,
  message: DecodedMessage,
  owner: Address,
  tree: Address
): void {
  if (message.instructions.length !== 2) mismatch();
  const computeProgram = validateComputeInstruction(
    message,
    message.instructions[0] as DecodedInstruction
  );
  const instruction = resolvedInstruction(message, message.instructions[1] as DecodedInstruction);
  if (instruction.program !== SHIELDED_POOL_PROGRAM_ID) mismatch();
  if (input.intent.opType === "shield") mismatch();
  const interfaceTransfers = parsePublicInterfaceTransfers(instruction.data);

  const commonAccounts: AccountExpectation[] = [
    { address: owner, signer: true, writable: true },
    { address: tree, signer: false, writable: true },
    { address: tree, signer: false, writable: true },
    { address: SHIELDED_POOL_PROGRAM_ID, signer: false, writable: false },
    { address: SYSTEM_PROGRAM, signer: false, writable: false },
  ];

  if (input.intent.opType === "transfer_registered") {
    // These fields must be well formed, but they are encrypted in the wire and
    // cannot be re-derived here. `validatePreparedTransferIntent` binds them
    // before encryption; this layer proves there is no public settlement.
    requiredAddress(input.intent.mint);
    requiredAmount(input.intent.amountRaw);
    if (interfaceTransfers.length !== 0) mismatch();
    expectAccounts(instruction.accounts, commonAccounts);
    expectStaticAccounts(message, [
      owner,
      tree,
      SHIELDED_POOL_PROGRAM_ID,
      SYSTEM_PROGRAM,
      computeProgram,
    ]);
    return;
  }

  if (
    input.intent.opType !== "withdraw" ||
    protocolMint(input.intent.mint) !== PROTOCOL_NATIVE_MINT
  ) {
    mismatch();
  }
  const amount = requiredAmount(input.intent.amountRaw);
  const recipient = requiredAddress(input.intent.to);
  const settlement = interfaceTransfers[0];
  if (interfaceTransfers.length !== 1 || settlement?.tag !== 1 || settlement.amount !== amount) {
    mismatch();
  }
  expectAccounts(instruction.accounts, [
    ...commonAccounts,
    { address: SOL_INTERFACE, signer: false, writable: true },
    // If recipient === owner, Solana correctly merges this with the signer role.
    { address: recipient, writable: true },
  ]);
  expectStaticAccounts(message, [
    owner,
    tree,
    SHIELDED_POOL_PROGRAM_ID,
    SYSTEM_PROGRAM,
    SOL_INTERFACE,
    recipient,
    computeProgram,
  ]);
}

async function validate(input: OuterTransactionPolicyInput): Promise<void> {
  const owner = requiredAddress(input.owner);
  const tree = requiredAddress(input.expectedTree ?? DEFAULT_TREE_ADDRESS);
  const transactionBytes = new Uint8Array(getBase64Codec().encode(input.outerUnsignedTxBase64));
  const [transaction, transactionOffset] = getTransactionDecoder().read(transactionBytes, 0);
  if (
    transactionOffset !== transactionBytes.length ||
    !equalBytes(getTransactionEncoder().encode(transaction), transactionBytes)
  ) {
    mismatch();
  }

  const [decodedMessage, messageOffset] = getCompiledTransactionMessageDecoder().read(
    transaction.messageBytes,
    0
  );
  if (
    messageOffset !== transaction.messageBytes.length ||
    !equalBytes(
      getCompiledTransactionMessageEncoder().encode(decodedMessage),
      transaction.messageBytes
    )
  ) {
    mismatch();
  }
  const message = decodedMessage as DecodedMessage;

  if (input.intent.opType === "shield") {
    validateEnvelope(message, transaction.signatures, owner);
    await validateShield(input, message, owner, tree);
    return;
  }
  const intent = input.intent;
  if (intent.ringProgramId !== undefined) {
    await validateRingSpend(
      { ...intent, ringProgramId: intent.ringProgramId },
      message,
      transaction.signatures,
      owner,
      tree
    );
    return;
  }
  validateEnvelope(message, transaction.signatures, owner);
  validateSpend(input, message, owner, tree);
}

/**
 * Validates the final unsigned outer bytes against the approved public intent.
 *
 * The signature intentionally contains only strings and plain DTOs so Kit 7
 * brands cannot cross into Kit 6 callers.
 */
export async function validateOuterTransaction(input: OuterTransactionPolicyInput): Promise<void> {
  try {
    await validate(input);
  } catch {
    // Never retain decoder errors or transaction bytes as a cause. They may
    // contain ciphertext or caller-controlled data and adapters log failures.
    throw new HeliusRingsError("invalid_input", SAFE_MESSAGE);
  }
}
