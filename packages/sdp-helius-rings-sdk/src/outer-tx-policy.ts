import { CUSTOM_RING_PROOF_LENGTH } from "@heliuslabs/zolana/client";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  DEFAULT_TREE_ADDRESS,
  MERGE_INPUT_COUNT,
  SHIELDED_POOL_CPI_AUTHORITY,
  SHIELDED_POOL_PROGRAM_ID,
  SOL_INTERFACE,
  SPL_TOKEN_2022_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  USER_REGISTRY_PROGRAM_ID,
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
import { PROTOCOL_NATIVE_MINT, PROTOCOL_SPEND_MINTS, protocolMint } from "./flows/mint.js";

const SAFE_MESSAGE = "the unsigned Rings transaction does not match the approved operation";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const DEPOSIT_TAG = 11;
const RING_DEPOSIT_TAG = 14;
const TRANSACT_TAG = 12;
const MERGE_TRANSACT_TAG = 13;
/**
 * A merge's instruction data is fixed width: the 8-in/1-out circuit shape is
 * baked into the layout, so every field including the three root-index vectors
 * has a constant length. Tag byte plus `encodeMergeTransactInstructionData`'s
 * 492. A unit test pins this against the encoder.
 */
const MERGE_DATA_LENGTH = 1 + 492;
/** Offsets of the three length prefixes inside that layout, tag included. */
const MERGE_COUNT_OFFSETS = [202, 459, 476] as const;
/** Seed of the user registry's record PDA, mirroring zolana's `RECORD_SEED`. */
const USER_RECORD_SEED = "zolana/registry/v0";
/** Byte 0 of a ring program's transact instruction (its own dispatch, not the pool's). */
const RING_TRANSACT_TAG = 3;
/**
 * Interface-transfer kinds inside a transact body, in Zolana's encoding order:
 * `solDeposit`, `solWithdrawal`, `splDeposit`, `splWithdrawal`. Only the two
 * withdrawal tags can appear on a spend this SDK builds.
 */
const SOL_WITHDRAWAL_TAG = 1;
const SPL_WITHDRAWAL_TAG = 3;
/** The associated token program's `createIdempotent` discriminator, its whole data. */
const CREATE_ASSOCIATED_TOKEN_IDEMPOTENT_DATA = Uint8Array.of(1);
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
    }>
  | Readonly<{
      /**
       * Consolidating the owner's own notes. No amount and no recipient: a
       * merge names only the asset, and the value it moves is whatever the
       * notes it consumes already held.
       */
      opType: "merge";
      mint: string;
    }>
  /**
   * A ring move: the wallet's own funds cross between the named ring and the
   * default pool, ring_exit out of it, ring_entry into it. Always ring-bound,
   * so `ring` is required. The wire is transfer-shaped — no public settlement;
   * amount, recipient, and destination pool live in encrypted outputs and are
   * bound by construction in the SDK (entry is self-only in the builder, an
   * exit's recipient is the wallet's own lifted shielded address), not proved
   * here. See docs/ops/helius-rings.md, "Semantics worth knowing".
   */
  | Readonly<{
      opType: "ring_exit" | "ring_entry";
      mint: string;
      amountRaw: string;
      ring: Readonly<{ programId: string; lookupTable: string }>;
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
  /** Present on the two SPL tags only; the vault PDA's bump seed. */
  readonly splInterfaceBump?: number;
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
    // The SPL tags carry the vault bump; it is a public input to the proof, so
    // the settlement check binds it rather than skipping past it.
    const isSpl = tag === 2 || tag === 3;
    interfaceTransfers.push({
      tag,
      amount,
      ...(isSpl ? { splInterfaceBump: reader.u8() } : {}),
    });
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

/**
 * The two SPL accounts a settlement reaches, for whichever side holds the
 * tokens: the depositor's on a shield, the recipient's on a withdrawal.
 */
async function splAccounts(
  tokenOwner: Address,
  mint: Address
): Promise<
  Readonly<{
    associatedTokenAccount: Address;
    splInterface: Address;
    bump: number;
  }>
> {
  const [associatedTokenAccount] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ID,
    seeds: [
      addressEncoder.encode(tokenOwner),
      addressEncoder.encode(SPL_TOKEN_PROGRAM_ID),
      addressEncoder.encode(mint),
    ],
  });
  const [splInterface, bump] = await getProgramDerivedAddress({
    programAddress: SHIELDED_POOL_PROGRAM_ID,
    seeds: [textEncoder.encode("spl_asset_vault"), addressEncoder.encode(mint)],
  });
  return { associatedTokenAccount, splInterface, bump };
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
 * zolana's `ringLookupTableAddresses` with inputTree === outputTree deduped,
 * then its `ringSettlementStatics`, which 0.1.6 puts in every new table; a
 * unit test pins the two together so upstream drift breaks the build instead
 * of custody.
 *
 * A table rented before 0.1.6 holds only the first group and still spends SOL:
 * the settlement group is appended, so an index into the shorter table
 * resolves to the same address, and a SOL ring transact never names those
 * three. An SPL ring withdrawal does name two of them, and over a short table
 * the builder can only emit them as statics — which this list says should have
 * been compressed, so the spend is refused rather than signed. Such a ring
 * cannot withdraw USDC; bring-up is what rents a table, and custody signs no
 * second extend.
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
    // Settlement accounts a public withdrawal's interface transfer reaches.
    SHIELDED_POOL_CPI_AUTHORITY,
    SPL_TOKEN_PROGRAM_ID,
    SPL_TOKEN_2022_PROGRAM_ID,
  ];
}

/**
 * The lookup-list analog of `expectStaticAccounts`: what each index list loads
 * must be exactly the expected set — nothing extra rides along as writable.
 * Set equality suffices: the envelope made the indexes unique and the table's
 * addresses are distinct, so lengths plus membership pin both sides.
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
  | { opType: "transfer_registered" }
  | { opType: "withdraw" }
  | { opType: "ring_exit" | "ring_entry" }
>;

/** What a settlement appends to the transact's account and static lists. */
interface ExpectedSettlement {
  readonly extraAccounts: readonly AccountExpectation[];
  readonly extraStatics: readonly string[];
  /**
   * The recipient's token account an SPL withdrawal must also have created
   * ahead of the transact. Absent on the two settlements that need no setup.
   */
  readonly createAssociatedTokenAccount?: Readonly<{
    mint: string;
    recipient: Address;
    tokenAccount: Address;
  }>;
}

/**
 * The public settlement a spend's wire must carry: exactly the approved
 * recipient and amount on a withdraw, none on anything else (transfers and
 * ring moves settle shielded). Returns what the settlement appends to the
 * transact's common account and static lists. A shielded spend's recipient and
 * amount are encrypted in the wire and only checked for well-formedness here;
 * where they ARE bound differs by rail (see docs/ops/helius-rings.md,
 * "Semantics worth knowing").
 *
 * A withdraw settles one of two ways. SOL reaches the pool's native interface
 * and credits the recipient's system account directly. An SPL asset reaches
 * that mint's vault PDA and credits the recipient's associated token account,
 * whose derivations are redone here from the approved mint and recipient — the
 * builder's addresses are never taken on trust.
 */
async function expectPublicSettlement(
  intent: SpendPolicyIntent,
  interfaceTransfers: readonly ParsedInterfaceTransfer[]
): Promise<ExpectedSettlement> {
  if (intent.opType !== "withdraw") {
    // A ring move settles shielded like a registered transfer, but its gate is
    // still SOL-only in the builders, so the bytes assert the narrower set.
    if (intent.opType === "ring_exit" || intent.opType === "ring_entry") {
      requiredNativeMint(intent.mint);
    } else {
      requiredSpendMint(intent.mint);
    }
    requiredAmount(intent.amountRaw);
    if (interfaceTransfers.length !== 0) mismatch();
    return { extraAccounts: [], extraStatics: [] };
  }

  const protocolAsset = requiredSpendMint(intent.mint);
  const amount = requiredAmount(intent.amountRaw);
  const recipient = requiredAddress(intent.to);
  const settlement = interfaceTransfers[0];
  if (interfaceTransfers.length !== 1 || settlement === undefined || settlement.amount !== amount) {
    mismatch();
  }

  if (protocolAsset === PROTOCOL_NATIVE_MINT) {
    if (settlement.tag !== SOL_WITHDRAWAL_TAG) mismatch();
    return {
      extraAccounts: [
        { address: SOL_INTERFACE, signer: false, writable: true },
        // If recipient === owner, Solana correctly merges this with the signer role.
        { address: recipient, writable: true },
      ],
      extraStatics: [SOL_INTERFACE, recipient],
    };
  }

  const mint = address(protocolAsset);
  const derived = await splAccounts(recipient, mint);
  if (settlement.tag !== SPL_WITHDRAWAL_TAG || settlement.splInterfaceBump !== derived.bump) {
    mismatch();
  }
  return {
    extraAccounts: [
      { address: SHIELDED_POOL_CPI_AUTHORITY, signer: false, writable: false },
      { address: mint, signer: false, writable: false },
      { address: derived.splInterface, signer: false, writable: true },
      { address: derived.associatedTokenAccount, signer: false, writable: true },
      { address: SPL_TOKEN_PROGRAM_ID, signer: false, writable: false },
    ],
    extraStatics: [
      SHIELDED_POOL_CPI_AUTHORITY,
      mint,
      derived.splInterface,
      derived.associatedTokenAccount,
      SPL_TOKEN_PROGRAM_ID,
    ],
    createAssociatedTokenAccount: {
      mint: protocolAsset,
      recipient,
      tokenAccount: derived.associatedTokenAccount,
    },
  };
}

/**
 * The mint as the protocol spells it, refused unless it is one this build
 * settles. The wire policy asserts the SDK's spend gate independently: an SPL
 * asset with no vault this file can derive has no settlement to verify.
 */
function requiredSpendMint(mint: string): string {
  requiredAddress(mint);
  const protocolAsset = protocolMint(mint);
  if (!PROTOCOL_SPEND_MINTS.includes(protocolAsset)) mismatch();
  return protocolAsset;
}

/** The narrower gate the ring moves keep, asserted on the bytes. */
function requiredNativeMint(mint: string): void {
  requiredAddress(mint);
  if (protocolMint(mint) !== PROTOCOL_NATIVE_MINT) mismatch();
}

/**
 * The idempotent associated-token create an SPL withdrawal puts ahead of the
 * transact, so the vault has somewhere to send the tokens. Its accounts are
 * re-derived, not read: this is the only instruction in the message whose
 * program is not the shielded pool, and it names the recipient's system
 * address, which nothing else in an SPL withdraw does.
 *
 * `loaded` is empty on the pool rail and the ring's table on the ring rail,
 * where the system and Token programs this instruction names arrive
 * compressed rather than static.
 */
function validateCreateAssociatedTokenInstruction(
  message: DecodedMessage,
  instruction: DecodedInstruction,
  expected: NonNullable<ExpectedSettlement["createAssociatedTokenAccount"]>,
  owner: Address,
  loaded: readonly ResolvedAccount[] = []
): void {
  const resolved = resolvedInstruction(message, instruction, loaded);
  const programRole = accountRole(message, instruction.programAddressIndex);
  if (
    resolved.program !== ASSOCIATED_TOKEN_PROGRAM_ID ||
    programRole.signer ||
    programRole.writable ||
    !equalBytes(resolved.data, CREATE_ASSOCIATED_TOKEN_IDEMPOTENT_DATA)
  ) {
    mismatch();
  }
  expectAccounts(resolved.accounts, [
    { address: owner, signer: true, writable: true },
    { address: expected.tokenAccount, signer: false, writable: true },
    // Readonly here and absent from the transact, so an SPL withdrawal never
    // makes a third party's system account writable. Withdrawing to one's own
    // address is the exception the wire forces: the create names the owner,
    // Solana merges that meta with the fee payer's, and the merged entry is
    // writable — a role the owner already holds as the signer.
    { address: expected.recipient, writable: expected.recipient === owner },
    { address: expected.mint, signer: false, writable: false },
    { address: SYSTEM_PROGRAM, signer: false, writable: false },
    { address: SPL_TOKEN_PROGRAM_ID, signer: false, writable: false },
  ]);
}

/**
 * A ring-bound spend: one compute instruction, then the ring program's own
 * tag-3 transact — with one idempotent associated-token create in between when
 * the withdrawal settles an SPL asset — ALT-compressed over the ring's
 * persisted lookup table. For what this gate can and cannot prove (notably a
 * ring transfer's recipient and amount), see docs/ops/helius-rings.md,
 * "Semantics worth knowing".
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

  const transactIndex = message.instructions.length - 1;
  if (transactIndex < 1) mismatch();
  const computeProgram = validateComputeInstruction(
    message,
    message.instructions[0] as DecodedInstruction
  );
  const loaded = loadedAccounts(lookup, expectedTable);
  const instruction = resolvedInstruction(
    message,
    message.instructions[transactIndex] as DecodedInstruction,
    loaded
  );
  if (instruction.program !== ring) mismatch();
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

  const settlement = await expectPublicSettlement(intent, interfaceTransfers);
  const setup = settlement.createAssociatedTokenAccount;
  if (message.instructions.length !== (setup ? 3 : 2)) mismatch();
  if (setup) {
    validateCreateAssociatedTokenInstruction(
      message,
      message.instructions[1] as DecodedInstruction,
      setup,
      owner,
      loaded
    );
  }

  // The one difference from the pool rail: a settlement account the ring's
  // table already holds arrives as a lookup, not a static. Splitting on the
  // table rather than on the asset keeps this true if the table's contents
  // change — and it is the safe direction, since an account expected static
  // that arrives compressed (or the reverse) is a mismatch either way. The
  // table holds no mint-specific entry, so the vault and the recipient's
  // token account, the two writable ones, always stay static.
  const heldByTable = (candidate: string) => expectedTable.includes(candidate);

  expectAccounts(instruction.accounts, [...commonAccounts, ...settlement.extraAccounts]);
  expectStaticAccounts(message, [
    owner,
    ...settlement.extraStatics.filter((entry) => !heldByTable(entry)),
    ...(setup ? [ASSOCIATED_TOKEN_PROGRAM_ID as string, setup.recipient as string] : []),
    ring,
    computeProgram,
  ]);
  expectRingLookups(
    lookup,
    expectedTable,
    [tree as string],
    [
      ringConfig,
      SHIELDED_POOL_PROGRAM_ID as string,
      SYSTEM_PROGRAM,
      ringAuth,
      ...settlement.extraAccounts
        .filter((account) => !account.writable && heldByTable(account.address))
        .map((account) => account.address),
    ]
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
    { address: derived.associatedTokenAccount, signer: false, writable: true },
    { address: derived.splInterface, signer: false, writable: true },
  ]);
  expectStaticAccounts(message, [
    owner,
    tree,
    ...args.extraStatics,
    SHIELDED_POOL_PROGRAM_ID,
    SPL_TOKEN_PROGRAM_ID,
    protocolAsset,
    derived.associatedTokenAccount,
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

/**
 * The user registry's record for an owner. Derived locally with no RPC and no
 * zolana import, like `derivedRingAuthAddress` — this file's independent read
 * of the wire is the point, and this is the account that decides whose notes a
 * merge is allowed to consume.
 */
async function derivedUserRecordAddress(owner: Address): Promise<Address> {
  const [derived] = await getProgramDerivedAddress({
    programAddress: USER_REGISTRY_PROGRAM_ID,
    seeds: [textEncoder.encode(USER_RECORD_SEED), addressEncoder.encode(owner)],
  });
  return derived;
}

/**
 * A merge: one compute instruction, then the pool's own tag-13 transact.
 *
 * What this can prove is narrower than a spend's, and deliberately so. A merge
 * publishes no amount and no recipient — every value in its data is a
 * commitment, a nullifier or a proof point — so there is no public effect to
 * bind an approved figure to. What custody gets instead is that these bytes are
 * a merge, for this owner, against this owner's registry record, on the
 * expected tree, in the protocol's fixed 8-in/1-out shape, with no other
 * account reachable. Conservation of value is the circuit's job. See
 * docs/ops/helius-rings.md, "Semantics worth knowing".
 */
async function validateMerge(
  intent: Extract<OuterTransactionPolicyIntent, { opType: "merge" }>,
  message: DecodedMessage,
  owner: Address,
  tree: Address
): Promise<void> {
  if (message.instructions.length !== 2) mismatch();
  // A merge publishes no mint, so this only holds the approved intent to an
  // asset the build can spend at all — the wire has nothing to bind it to.
  requiredSpendMint(intent.mint);

  const computeProgram = validateComputeInstruction(
    message,
    message.instructions[0] as DecodedInstruction
  );
  const instruction = resolvedInstruction(message, message.instructions[1] as DecodedInstruction);
  if (instruction.program !== SHIELDED_POOL_PROGRAM_ID) mismatch();

  const data = instruction.data;
  if (data.length !== MERGE_DATA_LENGTH || data[0] !== MERGE_TRANSACT_TAG) mismatch();
  // Nullifiers and both root-index vectors, each pinned to the circuit's
  // padded width. Redundant with the fixed length above, and cheap: it is the
  // shape that makes a merge a merge.
  for (const offset of MERGE_COUNT_OFFSETS) {
    if (data[offset] !== MERGE_INPUT_COUNT) mismatch();
  }

  const userRecord = await derivedUserRecordAddress(owner);
  // Input and output tree are the same account twice, as the builder emits it.
  expectAccounts(instruction.accounts, [
    { address: tree, signer: false, writable: true },
    { address: tree, signer: false, writable: true },
    { address: owner, signer: true, writable: true },
    { address: userRecord, signer: false, writable: false },
    { address: SYSTEM_PROGRAM, signer: false, writable: false },
    { address: SHIELDED_POOL_PROGRAM_ID, signer: false, writable: false },
  ]);
  expectStaticAccounts(message, [
    owner,
    tree,
    userRecord,
    SHIELDED_POOL_PROGRAM_ID,
    SYSTEM_PROGRAM,
    computeProgram,
  ]);
}

/**
 * A default-pool spend: one compute instruction, then the pool's tag-12
 * transact — with one idempotent associated-token create in between when the
 * withdrawal settles an SPL asset. Nothing else may ride along, so the
 * instruction count is pinned to what the resolved settlement implies rather
 * than left open.
 */
async function validateSpend(
  intent: SpendPolicyIntent,
  message: DecodedMessage,
  owner: Address,
  tree: Address
): Promise<void> {
  const transactIndex = message.instructions.length - 1;
  if (transactIndex < 1) mismatch();
  const computeProgram = validateComputeInstruction(
    message,
    message.instructions[0] as DecodedInstruction
  );
  const instruction = resolvedInstruction(
    message,
    message.instructions[transactIndex] as DecodedInstruction
  );
  if (instruction.program !== SHIELDED_POOL_PROGRAM_ID) mismatch();
  const interfaceTransfers = parsePublicInterfaceTransfers(instruction.data);

  const commonAccounts: AccountExpectation[] = [
    { address: owner, signer: true, writable: true },
    { address: tree, signer: false, writable: true },
    { address: tree, signer: false, writable: true },
    { address: SHIELDED_POOL_PROGRAM_ID, signer: false, writable: false },
    { address: SYSTEM_PROGRAM, signer: false, writable: false },
  ];

  const settlement = await expectPublicSettlement(intent, interfaceTransfers);
  const setup = settlement.createAssociatedTokenAccount;
  if (message.instructions.length !== (setup ? 3 : 2)) mismatch();
  if (setup) {
    validateCreateAssociatedTokenInstruction(
      message,
      message.instructions[1] as DecodedInstruction,
      setup,
      owner
    );
  }

  expectAccounts(instruction.accounts, [...commonAccounts, ...settlement.extraAccounts]);
  expectStaticAccounts(message, [
    owner,
    tree,
    SHIELDED_POOL_PROGRAM_ID,
    SYSTEM_PROGRAM,
    ...settlement.extraStatics,
    ...(setup ? [ASSOCIATED_TOKEN_PROGRAM_ID as string, setup.recipient as string] : []),
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
  if (intent.opType === "merge") {
    validateEnvelope(message, transaction.signatures, owner);
    await validateMerge(intent, message, owner, tree);
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
  await validateSpend(intent, message, owner, tree);
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
