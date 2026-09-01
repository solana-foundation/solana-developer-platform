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
const TRANSACT_TAG = 12;
const U64_MAX = 0xffff_ffff_ffff_ffffn;
const COMPUTE_LIMIT = getSetComputeUnitLimitInstruction({ units: MAX_COMPUTE_UNIT_LIMIT });
const addressEncoder = getAddressEncoder();
const textEncoder = new TextEncoder();

export type OuterTransactionPolicyIntent =
  | Readonly<{
      opType: "shield";
      mint: string;
      amountRaw: string;
      expectedShieldedAddress: string;
    }>
  | Readonly<{
      opType: "transfer_registered";
      mint: string;
      amountRaw: string;
    }>
  | Readonly<{
      opType: "withdraw";
      mint: string;
      amountRaw: string;
      to: string;
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

interface DecodedMessage {
  readonly version: 0 | "legacy";
  readonly header: Readonly<{
    numSignerAccounts: number;
    numReadonlySignerAccounts: number;
    numReadonlyNonSignerAccounts: number;
  }>;
  readonly staticAccounts: readonly string[];
  readonly instructions: readonly DecodedInstruction[];
  readonly addressTableLookups?: readonly unknown[];
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
  const bytes = new Uint8Array(getBase58Encoder().encode(canonicalIdentity));
  if (bytes.length !== 65 || getBase58Decoder().decode(bytes) !== canonicalIdentity) {
    mismatch();
  }
  return bytes.slice(0, 32);
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

function parsePublicInterfaceTransfers(data: Uint8Array): readonly ParsedInterfaceTransfer[] {
  const reader = new StrictReader(data);
  if (reader.u8() !== TRANSACT_TAG) mismatch();

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

async function validateShield(
  input: OuterTransactionPolicyInput,
  message: DecodedMessage,
  owner: Address,
  tree: Address
): Promise<void> {
  if (input.intent.opType !== "shield" || message.instructions.length !== 1) mismatch();
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
  validateEnvelope(message, transaction.signatures, owner);

  if (input.intent.opType === "shield") {
    await validateShield(input, message, owner, tree);
    return;
  }
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
