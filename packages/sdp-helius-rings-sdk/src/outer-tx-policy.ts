import { CUSTOM_RING_PROOF_LENGTH } from "@heliuslabs/zolana/client";
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
       * Present when the spend was pinned to a custom ring at prepare time.
       * The transact must then be the ring program's own tag-3 instruction,
       * ALT-compressed over the ring's persisted lookup table.
       */
      ring?: Readonly<{ programId: string; lookupTable: string }>;
    }>
  | Readonly<{
      opType: "withdraw";
      mint: string;
      amountRaw: string;
      to: string;
      /** Same contract as the transfer arm's `ring`. */
      ring?: Readonly<{ programId: string; lookupTable: string }>;
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

/** The asset-kind prefix shared by tag-11 and tag-14 deposit payloads. */
function readDepositAsset(
  reader: StrictReader
): Readonly<{ assetKind: "sol" | "spl"; splInterfaceBump?: number }> {
  const kind = reader.u8();
  const asset: { assetKind: "sol" | "spl"; splInterfaceBump?: number } =
    kind === 0
      ? { assetKind: "sol" }
      : kind === 1
        ? { assetKind: "spl", splInterfaceBump: reader.u8() }
        : mismatch();
  if (reader.u8() !== 1 || reader.u8() !== 0) mismatch();
  return asset;
}

function parseDeposit(data: Uint8Array): ParsedDeposit {
  const reader = new StrictReader(data);
  if (reader.u8() !== DEPOSIT_TAG || reader.u8() !== 1) mismatch();

  const asset = readDepositAsset(reader);
  const viewTag = reader.bytes(32);
  const recipientOwnerHash = reader.bytes(32);
  reader.bytes(32); // random blinding
  const amount = reader.u64();
  // The enabled shield builder supplies neither UTXO data nor a memo.
  if (reader.bool() || reader.bool()) mismatch();
  reader.done();

  return { ...asset, viewTag, recipientOwnerHash, amount };
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

  const asset = readDepositAsset(reader);
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

  return { ...asset, viewTag, amount };
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
  reader.bytes(CUSTOM_RING_PROOF_LENGTH);
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

type ResolvedAccount = Readonly<{ address: string; signer: boolean; writable: boolean }>;

/**
 * The accounts a validated lookup loads, in v0 message order (all writable
 * indexes, then all readonly), resolved against the locally derived table.
 */
function loadedAccounts(
  lookup: DecodedAddressTableLookup,
  expectedTable: readonly string[]
): readonly ResolvedAccount[] {
  const resolve = (index: number, writable: boolean): ResolvedAccount => {
    const accountAddress = expectedTable[index];
    if (!accountAddress) mismatch();
    return { address: accountAddress, signer: false, writable };
  };
  return [
    ...lookup.writableIndexes.map((index) => resolve(index, true)),
    ...lookup.readonlyIndexes.map((index) => resolve(index, false)),
  ];
}

/**
 * Resolves an instruction over the message's combined account space
 * `[statics..., loaded lookups...]`. With no loaded accounts (a legacy-shaped
 * v0 message) any index past the statics is a mismatch. The program address
 * must stay static: programs cannot be loaded through a lookup table.
 */
function resolvedInstruction(
  message: DecodedMessage,
  instruction: DecodedInstruction,
  loaded: readonly ResolvedAccount[] = []
): Readonly<{
  program: string;
  accounts: readonly ResolvedAccount[];
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
    return loaded[index - statics] ?? mismatch();
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

/**
 * The custody envelope invariant, one copy for every op type: version 0, the
 * owner as the only signer, and exactly one unsigned signature slot keyed by
 * the owner. Without `lookups` the message must carry no address-table
 * lookups; with it, exactly one over the given table, every index unique and
 * in range — an address named in `writableIndexes` is writable in the signed
 * transaction even if no instruction references it, so the index lists are
 * part of the account universe custody signs.
 */
function validateEnvelope(
  message: DecodedMessage,
  signatures: Record<string, unknown>,
  owner: Address,
  lookups?: Readonly<{ table: Address; tableLength: number }>
): DecodedAddressTableLookup | null {
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

  const tableLookups = message.addressTableLookups ?? [];
  if (!lookups) {
    if (tableLookups.length !== 0) mismatch();
    return null;
  }

  const lookup = tableLookups[0];
  if (tableLookups.length !== 1 || !lookup || lookup.lookupTableAddress !== lookups.table) {
    mismatch();
  }
  const indexes = [...lookup.writableIndexes, ...lookup.readonlyIndexes];
  if (new Set(indexes).size !== indexes.length) mismatch();
  for (const index of indexes) {
    if (!Number.isInteger(index) || index < 0 || index >= lookups.tableLength) mismatch();
  }
  return lookup;
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

/**
 * The ring program's own signer PDA; the one account a ring deposit adds.
 * Derived locally on purpose — not zolana's `ringAuthAddress` — as part of
 * this file's independent read of the wire.
 */
async function derivedRingAuthAddress(ringProgramId: Address): Promise<Address> {
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
    await derivedRingAuthAddress(ring),
    ring,
    COMPUTE_LIMIT.programAddress,
  ];
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

type SpendPolicyIntent = Extract<
  OuterTransactionPolicyIntent,
  { opType: "transfer_registered" } | { opType: "withdraw" }
>;

/**
 * The public settlement a spend's wire must carry: none on a transfer,
 * exactly the approved recipient and amount on a withdraw. Returns what the
 * settlement appends to the transact's common account and static lists. A
 * transfer's recipient and amount are encrypted in the wire and only checked
 * for well-formedness here; where they ARE bound differs by rail (see
 * docs/ops/helius-rings.md, "Semantics worth knowing").
 */
function expectPublicSettlement(
  intent: SpendPolicyIntent,
  interfaceTransfers: readonly ParsedInterfaceTransfer[]
): Readonly<{
  extraAccounts: readonly AccountExpectation[];
  extraStatics: readonly string[];
}> {
  if (intent.opType === "transfer_registered") {
    requiredAddress(intent.mint);
    requiredAmount(intent.amountRaw);
    if (interfaceTransfers.length !== 0) mismatch();
    return { extraAccounts: [], extraStatics: [] };
  }

  const amount = requiredAmount(intent.amountRaw);
  const recipient = requiredAddress(intent.to);
  const settlement = interfaceTransfers[0];
  if (interfaceTransfers.length !== 1 || settlement?.tag !== 1 || settlement.amount !== amount) {
    mismatch();
  }
  return {
    extraAccounts: [
      { address: SOL_INTERFACE, signer: false, writable: true },
      // If recipient === owner, Solana correctly merges this with the signer role.
      { address: recipient, writable: true },
    ],
    extraStatics: [SOL_INTERFACE, recipient],
  };
}

/**
 * A ring-bound spend: one compute instruction, then the ring program's own
 * tag-3 transact, ALT-compressed over the ring's persisted lookup table. For
 * what this gate can and cannot prove (notably a ring transfer's recipient
 * and amount), see docs/ops/helius-rings.md, "Semantics worth knowing".
 */
async function validateRingSpend(
  intent: SpendPolicyIntent & { ring: Readonly<{ programId: string; lookupTable: string }> },
  message: DecodedMessage,
  signatures: Record<string, unknown>,
  owner: Address,
  tree: Address
): Promise<void> {
  const ring = requiredAddress(intent.ring.programId);
  const ringLookupTable = requiredAddress(intent.ring.lookupTable);
  const expectedTable = await expectedRingTable(ring, tree);

  const lookup = validateEnvelope(message, signatures, owner, {
    table: ringLookupTable,
    tableLength: expectedTable.length,
  });
  if (!lookup) mismatch();

  if (message.instructions.length !== 2) mismatch();
  const computeProgram = validateComputeInstruction(
    message,
    message.instructions[0] as DecodedInstruction
  );
  const instruction = resolvedInstruction(
    message,
    message.instructions[1] as DecodedInstruction,
    loadedAccounts(lookup, expectedTable)
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

  const settlement = expectPublicSettlement(intent, interfaceTransfers);
  expectAccounts(instruction.accounts, [...commonAccounts, ...settlement.extraAccounts]);
  expectStaticAccounts(message, [owner, ...settlement.extraStatics, ring, computeProgram]);
  expectRingLookups(
    lookup,
    expectedTable,
    [tree as string],
    [ringConfig, SHIELDED_POOL_PROGRAM_ID as string, SYSTEM_PROGRAM, ringAuth]
  );
}

type ShieldPolicyIntent = Extract<OuterTransactionPolicyIntent, { opType: "shield" }>;

/**
 * The deposit's account expectations, shared by the pool and ring rails: the
 * ring rail inserts its ring-auth PDA after the owner and adds the ring plus
 * that PDA to the statics; everything else, including the SPL vault
 * derivation and bump check, is identical.
 */
async function expectDepositAccounts(
  args: Readonly<{
    message: DecodedMessage;
    accounts: readonly ResolvedAccount[];
    deposit: Readonly<{ assetKind: "sol" | "spl"; splInterfaceBump?: number }>;
    mint: string;
    owner: Address;
    tree: Address;
    afterOwner: readonly AccountExpectation[];
    extraStatics: readonly string[];
  }>
): Promise<void> {
  const { message, accounts, deposit, owner, tree } = args;
  const protocolAsset = protocolMint(args.mint);
  if (protocolAsset === PROTOCOL_NATIVE_MINT) {
    if (deposit.assetKind !== "sol") mismatch();
    expectAccounts(accounts, [
      { address: tree, signer: false, writable: true },
      { address: owner, signer: true, writable: true },
      ...args.afterOwner,
      { address: SHIELDED_POOL_PROGRAM_ID, signer: false, writable: false },
      { address: SYSTEM_PROGRAM, signer: false, writable: false },
      { address: SOL_INTERFACE, signer: false, writable: true },
    ]);
    expectStaticAccounts(message, [
      owner,
      tree,
      ...args.extraStatics,
      SHIELDED_POOL_PROGRAM_ID,
      SYSTEM_PROGRAM,
      SOL_INTERFACE,
    ]);
    return;
  }

  if (deposit.assetKind !== "spl") mismatch();
  const derived = await splAccounts(owner, address(protocolAsset));
  if (deposit.splInterfaceBump !== derived.bump) mismatch();
  expectAccounts(accounts, [
    { address: tree, signer: false, writable: true },
    { address: owner, signer: true, writable: true },
    ...args.afterOwner,
    { address: SHIELDED_POOL_PROGRAM_ID, signer: false, writable: false },
    { address: SPL_TOKEN_PROGRAM_ID, signer: false, writable: false },
    { address: protocolAsset, signer: false, writable: false },
    { address: derived.sourceTokenAccount, signer: false, writable: true },
    { address: derived.splInterface, signer: false, writable: true },
  ]);
  expectStaticAccounts(message, [
    owner,
    tree,
    ...args.extraStatics,
    SHIELDED_POOL_PROGRAM_ID,
    SPL_TOKEN_PROGRAM_ID,
    protocolAsset,
    derived.sourceTokenAccount,
    derived.splInterface,
  ]);
}

async function validateRingShield(
  intent: ShieldPolicyIntent & { ringProgramId: string },
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

  const ringAuth = await derivedRingAuthAddress(ring);
  await expectDepositAccounts({
    message,
    accounts: instruction.accounts,
    deposit,
    mint: intent.mint,
    owner,
    tree,
    // The ring program signs this account inside its CPI to the pool.
    afterOwner: [{ address: ringAuth, signer: false, writable: false }],
    extraStatics: [ring, ringAuth],
  });
}

async function validateShield(
  intent: ShieldPolicyIntent,
  message: DecodedMessage,
  owner: Address,
  tree: Address
): Promise<void> {
  if (message.instructions.length !== 1) mismatch();
  const instruction = resolvedInstruction(message, message.instructions[0] as DecodedInstruction);
  if (instruction.program !== SHIELDED_POOL_PROGRAM_ID) mismatch();

  const amount = requiredAmount(intent.amountRaw);
  const ownerHash = expectedOwnerHash(intent.expectedShieldedAddress);
  const deposit = parseDeposit(instruction.data);
  if (
    deposit.amount !== amount ||
    !equalBytes(deposit.viewTag, new Uint8Array(addressEncoder.encode(owner))) ||
    !equalBytes(deposit.recipientOwnerHash, ownerHash)
  ) {
    mismatch();
  }

  await expectDepositAccounts({
    message,
    accounts: instruction.accounts,
    deposit,
    mint: intent.mint,
    owner,
    tree,
    afterOwner: [],
    extraStatics: [],
  });
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
  intent: SpendPolicyIntent,
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
  if (intent.opType === "withdraw" && protocolMint(intent.mint) !== PROTOCOL_NATIVE_MINT) {
    mismatch();
  }
  const interfaceTransfers = parsePublicInterfaceTransfers(instruction.data);

  const commonAccounts: AccountExpectation[] = [
    { address: owner, signer: true, writable: true },
    { address: tree, signer: false, writable: true },
    { address: tree, signer: false, writable: true },
    { address: SHIELDED_POOL_PROGRAM_ID, signer: false, writable: false },
    { address: SYSTEM_PROGRAM, signer: false, writable: false },
  ];

  const settlement = expectPublicSettlement(intent, interfaceTransfers);
  expectAccounts(instruction.accounts, [...commonAccounts, ...settlement.extraAccounts]);
  expectStaticAccounts(message, [
    owner,
    tree,
    SHIELDED_POOL_PROGRAM_ID,
    SYSTEM_PROGRAM,
    ...settlement.extraStatics,
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

  const intent = input.intent;
  if (intent.opType === "shield") {
    validateEnvelope(message, transaction.signatures, owner);
    if (intent.ringProgramId !== undefined) {
      await validateRingShield(
        { ...intent, ringProgramId: intent.ringProgramId },
        message,
        owner,
        tree
      );
    } else {
      await validateShield(intent, message, owner, tree);
    }
    return;
  }
  if (intent.ring !== undefined) {
    await validateRingSpend(
      { ...intent, ring: intent.ring },
      message,
      transaction.signatures,
      owner,
      tree
    );
    return;
  }
  validateEnvelope(message, transaction.signatures, owner);
  validateSpend(intent, message, owner, tree);
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
