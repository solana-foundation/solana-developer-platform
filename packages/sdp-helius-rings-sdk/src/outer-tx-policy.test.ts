import { getAssociatedTokenAddress } from "@heliuslabs/zolana/addresses";
import { CUSTOM_RING_PROOF_LENGTH } from "@heliuslabs/zolana/client";
import {
  DEFAULT_TREE_ADDRESS,
  DepositAsset,
  depositInstruction,
  SHIELDED_POOL_PROGRAM_ID,
  SOL_INTERFACE,
  SPL_TOKEN_PROGRAM_ID,
} from "@heliuslabs/zolana/interface";
import {
  buildRingDepositTransaction,
  ringAuthAddress,
  ringConfigAddress,
  ringLookupTableAddresses,
} from "@heliuslabs/zolana/ring";
import {
  AccountRole,
  type Address,
  address,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getAddressEncoder,
  getBase58Decoder,
  getBase64Codec,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
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
import {
  expectedRingTable,
  type OuterTransactionPolicyInput,
  validateOuterTransaction,
} from "./outer-tx-policy.js";
import { derivedIdentity, TEST_REQUEST, withDerived } from "./test/shielded-identity-fixtures.js";

const OWNER = address("GsbwXfJraMomNxBcjK1DiP5Mth8ZmQpDUFTmKfhtiHgo");
const OTHER = address("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
const RECIPIENT = address("6Ecs4vFmtiZ7WeQMWZibhFPQF3q3Pmqrb7CQGRJJKQTM");
const MINT = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const OTHER_MINT = address("E4KqM12ZDosJbV7gZ5iR8rK1T2mC3nF4pQ6sU8wX9yZa");
const SYSTEM = address("11111111111111111111111111111111");
const MEMO = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const SDP_SOL = "So11111111111111111111111111111111111111112";
const BLOCKHASH = "5DjPMLBWWLbNw3TRUEbCwPFvpXqhkdVv2VUb3RJhZmpJ";
const TRANSACT_TAG = 12;
// Bytes between the transact tag and its input-count byte are opaque to custody.
const TRANSACT_OPAQUE_PREFIX_LENGTH = 222;
const TRANSACT_INPUT_LENGTH = 36;
const OWNER_HASH = new Uint8Array(32).fill(3);
const OTHER_HASH = new Uint8Array(32).fill(4);
const OWNER_VIEW_TAG = new Uint8Array(getAddressEncoder().encode(OWNER));
const SHIELDED_IDENTITY = getBase58Decoder().decode(
  Uint8Array.from([...OWNER_HASH, ...new Uint8Array(33).fill(5)])
);
// Any deployed program can name a ring; two distinct ids so a swap cannot pass.
const RING_PROGRAM = address("Stake11111111111111111111111111111111111111");
const OTHER_RING = address("Vote111111111111111111111111111111111111111");
// Byte offsets inside a single-asset SOL ring deposit's data: tag(1),
// asset vec(1+1), deposit vec header(1+1), viewTag(32), ownerUtxoHash(32),
// then the LE amount, the UTXO data-hash option byte, and the ring data hash.
const RING_AMOUNT_OFFSET = 69;
const RING_DATA_HASH_OPTION_OFFSET = 77;
const RING_DATA_HASH_OFFSET = 78;

function bytes(length: number, fill: number): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

function instructionData(instruction: Instruction): Uint8Array {
  if (!instruction.data) throw new Error("test instruction has no data");
  return new Uint8Array(instruction.data);
}

function replaceData(instruction: Instruction, data: Uint8Array): Instruction {
  return { ...instruction, data };
}

function encodeTransaction(
  instructions: readonly Instruction[],
  options: {
    feePayer?: Address;
    version?: 0 | "legacy";
  } = {}
): string {
  const transaction = compileTransaction(
    pipe(
      createTransactionMessage({ version: options.version ?? 0 }),
      (message) => setTransactionMessageFeePayer(options.feePayer ?? OWNER, message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: BLOCKHASH as Blockhash, lastValidBlockHeight: 100n },
          message
        ),
      (message) => appendTransactionMessageInstructions(instructions, message)
    )
  );
  return getBase64Codec().decode(getTransactionEncoder().encode(transaction));
}

function mutateWire(value: string, mutate: (bytes: Uint8Array) => Uint8Array): string {
  return getBase64Codec().decode(mutate(new Uint8Array(getBase64Codec().encode(value))));
}

async function solDeposit(amount = 10n, ownerHash = OWNER_HASH): Promise<Instruction> {
  return depositInstruction({
    tree: DEFAULT_TREE_ADDRESS,
    depositor: OWNER,
    deposits: [
      {
        asset: DepositAsset.sol(),
        viewTag: OWNER_VIEW_TAG as never,
        recipientOwnerHash: ownerHash as never,
        blinding: bytes(32, 7) as never,
        amount,
      },
    ],
  });
}

async function splDeposit(mint: Address = MINT, amount = 10n): Promise<Instruction> {
  return depositInstruction({
    tree: DEFAULT_TREE_ADDRESS,
    depositor: OWNER,
    deposits: [
      {
        asset: DepositAsset.spl({
          mint,
          sourceTokenAccount: await getAssociatedTokenAddress(OWNER, mint),
          tokenProgram: SPL_TOKEN_PROGRAM_ID,
        }),
        viewTag: OWNER_VIEW_TAG as never,
        recipientOwnerHash: OWNER_HASH as never,
        blinding: bytes(32, 7) as never,
        amount,
      },
    ],
  });
}

/**
 * A real ring-bound deposit from the builder production uses, addressed to the
 * fixture identity so the intent's shielded address round-trips its view tag.
 */
async function ringDepositWire(
  options: Readonly<{ ring?: Address; asset?: Address }> = {}
): Promise<string> {
  return withDerived(async (material) => {
    const transaction = await buildRingDepositTransaction({
      client: {
        getLatestBlockhash: async () => ({
          blockhash: BLOCKHASH as Blockhash,
          lastValidBlockHeight: 100n,
        }),
      } as never,
      ringProgramId: options.ring ?? RING_PROGRAM,
      feePayer: OWNER,
      recipient: material.shieldedAddress,
      tree: DEFAULT_TREE_ADDRESS,
      amount: 10n,
      ...(options.asset ? { asset: options.asset } : {}),
    });
    return getBase64Codec().decode(getTransactionEncoder().encode(transaction));
  });
}

/** Re-encodes the wire with every instruction's data bytes altered in place. */
function mutateInstructionData(wire: string, mutate: (data: Uint8Array) => void): string {
  const transaction = getTransactionDecoder().decode(getBase64Codec().encode(wire));
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  if (message.version !== 0) throw new Error("test transaction must use a v0 message");
  const instructions = message.instructions.map((instruction) => {
    const data = new Uint8Array(instruction.data ?? []);
    mutate(data);
    return { ...instruction, data };
  });
  return getBase64Codec().decode(
    getTransactionEncoder().encode({
      ...transaction,
      messageBytes: getCompiledTransactionMessageEncoder().encode({
        ...message,
        instructions,
      }) as (typeof transaction)["messageBytes"],
    })
  );
}

interface PublicSettlement {
  readonly tag: 0 | 1;
  readonly amount: bigint;
}

function u64Bytes(value: bigint): Uint8Array {
  const encoded = new Uint8Array(8);
  let remaining = value;
  for (let index = 0; index < encoded.length; index += 1) {
    encoded[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return encoded;
}

function opaqueTransactData(
  options: Readonly<{
    inputCount?: number;
    settlements?: readonly PublicSettlement[];
    tail?: Uint8Array;
  }> = {}
): Uint8Array {
  const inputCount = options.inputCount ?? 1;
  if (!Number.isInteger(inputCount) || inputCount < 0 || inputCount > 0xff) {
    throw new Error("test input count must fit in one byte");
  }
  const settlements = options.settlements ?? [];
  if (settlements.length > 0xff) throw new Error("test settlement count must fit in one byte");

  return Uint8Array.from([
    TRANSACT_TAG,
    ...bytes(TRANSACT_OPAQUE_PREFIX_LENGTH, 0x7a),
    inputCount,
    ...bytes(inputCount * TRANSACT_INPUT_LENGTH, 0x4b),
    settlements.length,
    ...settlements.flatMap((settlement) => [settlement.tag, ...u64Bytes(settlement.amount)]),
    ...(options.tail ?? bytes(5, 0xa5)),
  ]);
}

const commonSpendAccounts = [
  { address: OWNER, role: AccountRole.WRITABLE_SIGNER },
  { address: DEFAULT_TREE_ADDRESS, role: AccountRole.WRITABLE },
  { address: DEFAULT_TREE_ADDRESS, role: AccountRole.WRITABLE },
  { address: SHIELDED_POOL_PROGRAM_ID, role: AccountRole.READONLY },
  { address: SYSTEM, role: AccountRole.READONLY },
] as const;

function transferInstruction(data: Uint8Array = opaqueTransactData()): Instruction {
  return {
    programAddress: SHIELDED_POOL_PROGRAM_ID,
    accounts: commonSpendAccounts,
    data,
  };
}

function withdrawalInstruction(
  data: Uint8Array = opaqueTransactData({ settlements: [{ tag: 1, amount: 10n }] }),
  recipient: Address = RECIPIENT
): Instruction {
  return {
    programAddress: SHIELDED_POOL_PROGRAM_ID,
    accounts: [
      ...commonSpendAccounts,
      { address: SOL_INTERFACE, role: AccountRole.WRITABLE },
      { address: recipient, role: AccountRole.WRITABLE },
    ],
    data,
  };
}

function spendWire(protocolInstruction: Instruction): string {
  return encodeTransaction([
    getSetComputeUnitLimitInstruction({ units: MAX_COMPUTE_UNIT_LIMIT }),
    protocolInstruction,
  ]);
}

function spendWireWithWritableComputeProgram(): string {
  const compute = getSetComputeUnitLimitInstruction({ units: MAX_COMPUTE_UNIT_LIMIT });
  const wire = spendWire(transferInstruction());
  const transaction = getTransactionDecoder().decode(getBase64Codec().encode(wire));
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  if (message.version !== 0) throw new Error("test transaction must use a v0 message");
  const originalAccounts = [...message.staticAccounts];
  const computeIndex = originalAccounts.indexOf(compute.programAddress);
  if (computeIndex < 0) throw new Error("test message has no compute-budget program");
  const writableNonSigners =
    originalAccounts.length -
    message.header.numSignerAccounts -
    message.header.numReadonlyNonSignerAccounts;
  const writableBoundary = message.header.numSignerAccounts + writableNonSigners;
  const reorderedAccounts = originalAccounts.filter((_, index) => index !== computeIndex);
  reorderedAccounts.splice(writableBoundary, 0, compute.programAddress);
  const newIndexByAddress = new Map(
    reorderedAccounts.map((accountAddress, index) => [accountAddress, index])
  );
  const remapIndex = (oldIndex: number): number => {
    const accountAddress = originalAccounts[oldIndex];
    const newIndex = accountAddress ? newIndexByAddress.get(accountAddress) : undefined;
    if (newIndex === undefined) throw new Error("test account index cannot be remapped");
    return newIndex;
  };
  const modifiedMessage = {
    ...message,
    header: {
      ...message.header,
      numReadonlyNonSignerAccounts: message.header.numReadonlyNonSignerAccounts - 1,
    },
    staticAccounts: reorderedAccounts,
    instructions: message.instructions.map((instruction) => ({
      ...instruction,
      programAddressIndex: remapIndex(instruction.programAddressIndex),
      ...(instruction.accountIndices
        ? { accountIndices: instruction.accountIndices.map(remapIndex) }
        : {}),
    })),
  };
  return getBase64Codec().decode(
    getTransactionEncoder().encode({
      ...transaction,
      messageBytes: getCompiledTransactionMessageEncoder().encode(
        modifiedMessage
      ) as (typeof transaction)["messageBytes"],
    })
  );
}

function shieldPolicy(
  outerUnsignedTxBase64: string,
  overrides: Partial<Extract<OuterTransactionPolicyInput["intent"], { opType: "shield" }>> = {}
): OuterTransactionPolicyInput {
  return {
    outerUnsignedTxBase64,
    owner: OWNER,
    intent: {
      opType: "shield",
      mint: SDP_SOL,
      amountRaw: "10",
      expectedShieldedAddress: SHIELDED_IDENTITY,
      ...overrides,
    },
  };
}

function transferPolicy(
  outerUnsignedTxBase64: string,
  overrides: Partial<
    Extract<OuterTransactionPolicyInput["intent"], { opType: "transfer_registered" }>
  > = {}
): OuterTransactionPolicyInput {
  return {
    outerUnsignedTxBase64,
    owner: OWNER,
    intent: {
      opType: "transfer_registered",
      mint: SDP_SOL,
      amountRaw: "10",
      ...overrides,
    },
  };
}

function withdrawalPolicy(
  outerUnsignedTxBase64: string,
  overrides: Partial<Extract<OuterTransactionPolicyInput["intent"], { opType: "withdraw" }>> = {}
): OuterTransactionPolicyInput {
  return {
    outerUnsignedTxBase64,
    owner: OWNER,
    intent: {
      opType: "withdraw",
      mint: SDP_SOL,
      amountRaw: "10",
      to: RECIPIENT,
      ...overrides,
    },
  };
}

// --- ring-bound spend fixtures -----------------------------------------------

const RING_LOOKUP_TABLE = address("LookupTab1e11111111111111111111111111111111");
const RING_TRANSACT_TAG = 3;

/** The ring wire: `tag(3) || proof(192) || the pool transact body` (no inner tag). */
function ringTransactData(options: Parameters<typeof opaqueTransactData>[0] = {}): Uint8Array {
  return Uint8Array.from([
    RING_TRANSACT_TAG,
    ...bytes(CUSTOM_RING_PROOF_LENGTH, 0x33),
    ...opaqueTransactData(options).slice(1),
  ]);
}

async function ringTransfer(
  options: Readonly<{ ring?: Address; data?: Uint8Array }> = {}
): Promise<Instruction> {
  return ringSpendInstruction({
    ...options,
    data: options.data ?? ringTransactData({ settlements: [] }),
  });
}

async function ringWithdrawal(
  options: Readonly<{ ring?: Address; data?: Uint8Array; recipient?: Address }> = {}
): Promise<Instruction> {
  return ringSpendInstruction({
    ring: options.ring ?? RING_PROGRAM,
    data: options.data ?? ringTransactData({ settlements: [{ tag: 1, amount: 10n }] }),
    settlementRecipient: options.recipient ?? RECIPIENT,
  });
}

/** `ringTransactAccounts` verbatim: payer twice, both trees, ringAuth at index 7. */
async function ringSpendInstruction(
  options: Readonly<{ ring?: Address; data?: Uint8Array; settlementRecipient?: Address }>
): Promise<Instruction> {
  const ring = options.ring ?? RING_PROGRAM;
  const [ringConfig, ringAuth] = await Promise.all([
    ringConfigAddress(ring),
    ringAuthAddress(ring),
  ]);
  return {
    programAddress: ring,
    accounts: [
      { address: OWNER, role: AccountRole.WRITABLE_SIGNER },
      { address: ringConfig, role: AccountRole.READONLY },
      { address: OWNER, role: AccountRole.WRITABLE_SIGNER },
      { address: DEFAULT_TREE_ADDRESS, role: AccountRole.WRITABLE },
      { address: DEFAULT_TREE_ADDRESS, role: AccountRole.WRITABLE },
      { address: SHIELDED_POOL_PROGRAM_ID, role: AccountRole.READONLY },
      { address: SYSTEM, role: AccountRole.READONLY },
      { address: ringAuth, role: AccountRole.READONLY },
      ...(options.settlementRecipient
        ? [
            { address: SOL_INTERFACE, role: AccountRole.WRITABLE },
            { address: options.settlementRecipient, role: AccountRole.WRITABLE },
          ]
        : []),
    ],
    data: options.data ?? ringTransactData(),
  };
}

/** Compute budget + the ring transact, ALT-compressed like the real builders emit. */
async function ringSpendWire(
  instruction: Instruction,
  options: Readonly<{ lookupTable?: Address }> = {}
): Promise<string> {
  const tableAddress = options.lookupTable ?? RING_LOOKUP_TABLE;
  const tables = {
    [tableAddress]: [
      ...(await ringLookupTableAddresses({
        ringProgramId: RING_PROGRAM,
        tree: DEFAULT_TREE_ADDRESS,
      })),
    ],
  };
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
          [getSetComputeUnitLimitInstruction({ units: MAX_COMPUTE_UNIT_LIMIT }), instruction],
          message
        ),
      (message) => compressTransactionMessageUsingAddressLookupTables(message, tables as never)
    )
  );
  return getBase64Codec().decode(getTransactionEncoder().encode(transaction));
}

function ringTransferPolicy(
  outerUnsignedTxBase64: string,
  overrides: Partial<
    Extract<OuterTransactionPolicyInput["intent"], { opType: "transfer_registered" }>
  > = {}
): OuterTransactionPolicyInput {
  return transferPolicy(outerUnsignedTxBase64, {
    ring: { programId: RING_PROGRAM, lookupTable: RING_LOOKUP_TABLE },
    ...overrides,
  });
}

function ringWithdrawalPolicy(
  outerUnsignedTxBase64: string,
  overrides: Partial<Extract<OuterTransactionPolicyInput["intent"], { opType: "withdraw" }>> = {}
): OuterTransactionPolicyInput {
  return withdrawalPolicy(outerUnsignedTxBase64, {
    ring: { programId: RING_PROGRAM, lookupTable: RING_LOOKUP_TABLE },
    ...overrides,
  });
}

/**
 * Appends an index to one of the message's lookup lists without touching any
 * instruction — exactly the "unreferenced account rides along" shape the gate
 * must refuse, because a writable lookup is writable in the signed transaction
 * whether or not an instruction names it.
 */
function addLookupIndex(
  wire: string,
  list: "writableIndexes" | "readonlyIndexes",
  index: number
): string {
  const transaction = getTransactionDecoder().decode(getBase64Codec().encode(wire));
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  if (message.version !== 0 || !message.addressTableLookups?.[0]) {
    throw new Error("test transaction must be a compressed v0 message");
  }
  const lookup = message.addressTableLookups[0];
  const modified = {
    ...message,
    addressTableLookups: [{ ...lookup, [list]: [...lookup[list], index] }],
  };
  return getBase64Codec().decode(
    getTransactionEncoder().encode({
      ...transaction,
      messageBytes: getCompiledTransactionMessageEncoder().encode(
        modified as never
      ) as (typeof transaction)["messageBytes"],
    })
  );
}

async function expectPolicyRejection(input: OuterTransactionPolicyInput): Promise<void> {
  await expect(validateOuterTransaction(input)).rejects.toMatchObject({
    name: "HeliusRingsError",
    code: "invalid_input",
    message: "the unsigned Rings transaction does not match the approved operation",
  });
}

describe("validateOuterTransaction", () => {
  describe("transaction envelope", () => {
    it("rejects undecodable transaction bytes with a redacted, non-retryable domain code", async () => {
      const input = shieldPolicy("not-base64");

      await expectPolicyRejection(input);
      const error = await validateOuterTransaction(input).catch((value: unknown) => value);
      expect((error as Error).message).not.toContain("not-base64");
      expect((error as Error).message).not.toContain(OWNER);
      expect((error as Error).message).not.toContain("10");
    });

    it("rejects a legacy message", async () => {
      await expectPolicyRejection(
        shieldPolicy(encodeTransaction([await solDeposit()], { version: "legacy" }))
      );
    });

    it("rejects an address lookup table even when no instruction uses it", async () => {
      const wire = encodeTransaction([await solDeposit()]);
      const withLookup = mutateWire(wire, (encoded) =>
        Uint8Array.from([...encoded.slice(0, -1), 1, ...bytes(32, 21), 1, 0, 0])
      );

      await expectPolicyRejection(shieldPolicy(withLookup));
    });

    it("rejects the wrong fee payer", async () => {
      await expectPolicyRejection(
        shieldPolicy(encodeTransaction([await solDeposit()], { feePayer: OTHER }))
      );
    });

    it("rejects a second required signer from decoded message bytes", async () => {
      const deposit = await solDeposit();
      const withSigner: Instruction = {
        ...deposit,
        accounts: [
          ...(deposit.accounts ?? []),
          { address: OTHER, role: AccountRole.READONLY_SIGNER },
        ],
      };

      await expectPolicyRejection(shieldPolicy(encodeTransaction([withSigner])));
    });

    it("rejects bytes that are already signed", async () => {
      const signed = mutateWire(encodeTransaction([await solDeposit()]), (encoded) => {
        const changed = encoded.slice();
        changed[1] = 1;
        return changed;
      });

      await expectPolicyRejection(shieldPolicy(signed));
    });

    it("rejects trailing bytes after an otherwise valid transaction", async () => {
      const wire = encodeTransaction([await solDeposit()]);
      const trailing = mutateWire(wire, (encoded) => Uint8Array.from([...encoded, 99]));

      await expectPolicyRejection(shieldPolicy(trailing));
    });

    it("rejects a truncated address-lookup short-vector", async () => {
      const wire = encodeTransaction([await solDeposit()]);
      const truncated = mutateWire(wire, (encoded) => encoded.slice(0, -1));

      await expectPolicyRejection(shieldPolicy(truncated));
    });

    it("rejects an overlong noncanonical signature-count short-vector", async () => {
      const wire = encodeTransaction([await solDeposit()]);
      const overlong = mutateWire(wire, (encoded) =>
        Uint8Array.from([0x81, 0, ...encoded.slice(1)])
      );

      await expectPolicyRejection(shieldPolicy(overlong));
    });
  });

  describe("shield", () => {
    it("accepts the exact SOL deposit wire shape", async () => {
      await expect(
        validateOuterTransaction(shieldPolicy(encodeTransaction([await solDeposit()])))
      ).resolves.toBeUndefined();
    });

    it("accepts the exact SPL mint and account layout", async () => {
      await expect(
        validateOuterTransaction(
          shieldPolicy(encodeTransaction([await splDeposit()]), { mint: MINT })
        )
      ).resolves.toBeUndefined();
    });

    it.each([
      [
        "extra System instruction",
        async () => encodeTransaction([await solDeposit(), { programAddress: SYSTEM }]),
      ],
      [
        "extra Memo instruction",
        async () => encodeTransaction([await solDeposit(), { programAddress: MEMO }]),
      ],
      [
        "extra Token instruction",
        async () =>
          encodeTransaction([await solDeposit(), { programAddress: SPL_TOKEN_PROGRAM_ID }]),
      ],
      [
        "wrong pool program",
        async () => encodeTransaction([{ ...(await solDeposit()), programAddress: OTHER }]),
      ],
      [
        "wrong tree account",
        async () => {
          const deposit = await solDeposit();
          const accounts = [...(deposit.accounts ?? [])];
          accounts[0] = { address: OTHER, role: AccountRole.WRITABLE };
          return encodeTransaction([{ ...deposit, accounts }]);
        },
      ],
      [
        "wrong deposit tag",
        async () => {
          const deposit = await solDeposit();
          const data = instructionData(deposit).slice();
          data[0] = 12;
          return encodeTransaction([replaceData(deposit, data)]);
        },
      ],
      ["altered amount", async () => encodeTransaction([await solDeposit(11n)])],
      ["altered owner hash", async () => encodeTransaction([await solDeposit(10n, OTHER_HASH)])],
      [
        "altered owner view tag",
        async () => {
          const deposit = await solDeposit();
          const data = instructionData(deposit).slice();
          data[5] = 99;
          return encodeTransaction([replaceData(deposit, data)]);
        },
      ],
      [
        "trailing payload",
        async () => {
          const deposit = await solDeposit();
          return encodeTransaction([
            replaceData(deposit, Uint8Array.from([...instructionData(deposit), 99])),
          ]);
        },
      ],
      [
        "truncated payload",
        async () => {
          const deposit = await solDeposit();
          return encodeTransaction([replaceData(deposit, instructionData(deposit).slice(0, -1))]);
        },
      ],
      [
        "extra public account",
        async () => {
          const deposit = await solDeposit();
          return encodeTransaction([
            {
              ...deposit,
              accounts: [
                ...(deposit.accounts ?? []),
                { address: OTHER, role: AccountRole.WRITABLE },
              ],
            },
          ]);
        },
      ],
    ])("rejects %s", async (_case, buildWire) => {
      await expectPolicyRejection(shieldPolicy(await buildWire()));
    });

    it("rejects a different SPL mint than the requested asset", async () => {
      await expectPolicyRejection(
        shieldPolicy(encodeTransaction([await splDeposit(MINT)]), { mint: OTHER_MINT })
      );
    });
  });

  describe("ring-bound shield", () => {
    it("accepts the exact SOL ring deposit the pinned ring's builder emits", async () => {
      await expect(
        validateOuterTransaction(
          shieldPolicy(await ringDepositWire(), {
            expectedShieldedAddress: await derivedIdentity(),
            ringProgramId: RING_PROGRAM,
          })
        )
      ).resolves.toBeUndefined();
    });

    it("accepts the exact SPL ring mint and account layout", async () => {
      await expect(
        validateOuterTransaction(
          shieldPolicy(await ringDepositWire({ asset: MINT }), {
            mint: MINT,
            expectedShieldedAddress: await derivedIdentity(),
            ringProgramId: RING_PROGRAM,
          })
        )
      ).resolves.toBeUndefined();
    });

    it.each([
      [
        "a plain pool deposit when the intent pins a ring",
        async () =>
          shieldPolicy(encodeTransaction([await solDeposit()]), { ringProgramId: RING_PROGRAM }),
      ],
      [
        "a ring deposit when the intent pins no ring",
        async () =>
          shieldPolicy(await ringDepositWire(), {
            expectedShieldedAddress: await derivedIdentity(),
          }),
      ],
      [
        "a ring deposit from a ring other than the pinned one",
        async () =>
          shieldPolicy(await ringDepositWire({ ring: OTHER_RING }), {
            expectedShieldedAddress: await derivedIdentity(),
            ringProgramId: RING_PROGRAM,
          }),
      ],
      [
        "a tampered amount",
        async () =>
          shieldPolicy(
            mutateInstructionData(await ringDepositWire(), (data) => {
              data[RING_AMOUNT_OFFSET] = 11;
            }),
            { expectedShieldedAddress: await derivedIdentity(), ringProgramId: RING_PROGRAM }
          ),
      ],
      [
        "a view tag bound to a recipient other than the intent's",
        async () =>
          shieldPolicy(await ringDepositWire(), {
            expectedShieldedAddress: await derivedIdentity({
              ...TEST_REQUEST,
              walletId: "hrw_other",
            }),
            ringProgramId: RING_PROGRAM,
          }),
      ],
      [
        "a nonzero ring data hash",
        async () =>
          shieldPolicy(
            mutateInstructionData(await ringDepositWire(), (data) => {
              data[RING_DATA_HASH_OFFSET] = 1;
            }),
            { expectedShieldedAddress: await derivedIdentity(), ringProgramId: RING_PROGRAM }
          ),
      ],
      [
        "a present UTXO data-hash option",
        async () =>
          shieldPolicy(
            mutateInstructionData(await ringDepositWire(), (data) => {
              data[RING_DATA_HASH_OPTION_OFFSET] = 1;
            }),
            { expectedShieldedAddress: await derivedIdentity(), ringProgramId: RING_PROGRAM }
          ),
      ],
    ])("rejects %s", async (_case, buildInput) => {
      await expectPolicyRejection(await buildInput());
    });
  });

  describe("registered transfer", () => {
    it("accepts a transfer with no public settlement", async () => {
      await expect(
        validateOuterTransaction(transferPolicy(spendWire(transferInstruction())))
      ).resolves.toBeUndefined();
    });

    it("accepts arbitrary opaque tail bytes after the public settlement section", async () => {
      await expect(
        validateOuterTransaction(
          transferPolicy(
            spendWire(
              transferInstruction(
                opaqueTransactData({ tail: Uint8Array.from([0, 255, 17, 34, 51, 68, 85]) })
              )
            )
          )
        )
      ).resolves.toBeUndefined();
    });

    it("rejects a writable compute-budget program account", async () => {
      await expectPolicyRejection(transferPolicy(spendWireWithWritableComputeProgram()));
    });

    it.each([
      ["missing compute limit", () => encodeTransaction([transferInstruction()])],
      [
        "wrong compute limit",
        () =>
          encodeTransaction([
            getSetComputeUnitLimitInstruction({ units: MAX_COMPUTE_UNIT_LIMIT - 1 }),
            transferInstruction(),
          ]),
      ],
      [
        "extra arbitrary instruction",
        () =>
          encodeTransaction([
            getSetComputeUnitLimitInstruction({ units: MAX_COMPUTE_UNIT_LIMIT }),
            transferInstruction(),
            { programAddress: MEMO },
          ]),
      ],
      ["wrong pool", () => spendWire({ ...transferInstruction(), programAddress: OTHER })],
      [
        "public interface settlement",
        () =>
          spendWire(
            transferInstruction(opaqueTransactData({ settlements: [{ tag: 1, amount: 10n }] }))
          ),
      ],
      [
        "extra public writable recipient",
        () => {
          const transfer = transferInstruction();
          return spendWire({
            ...transfer,
            accounts: [
              ...(transfer.accounts ?? []),
              { address: RECIPIENT, role: AccountRole.WRITABLE },
            ],
          });
        },
      ],
      [
        "truncated opaque prefix",
        () => {
          const data = Uint8Array.from([
            TRANSACT_TAG,
            ...bytes(TRANSACT_OPAQUE_PREFIX_LENGTH - 1, 1),
          ]);
          return spendWire(transferInstruction(data));
        },
      ],
      [
        "truncated opaque input bytes",
        () => {
          const inputCount = 2;
          const data = opaqueTransactData({ inputCount, tail: new Uint8Array() });
          const settlementCountOffset =
            1 + TRANSACT_OPAQUE_PREFIX_LENGTH + 1 + inputCount * TRANSACT_INPUT_LENGTH;
          return spendWire(transferInstruction(data.slice(0, settlementCountOffset - 1)));
        },
      ],
      [
        "truncated public settlement amount",
        () => {
          const data = opaqueTransactData({
            settlements: [{ tag: 1, amount: 10n }],
            tail: new Uint8Array(),
          });
          return spendWire(transferInstruction(data.slice(0, -1)));
        },
      ],
    ])("rejects %s", async (_case, buildWire) => {
      await expectPolicyRejection(transferPolicy(buildWire()));
    });
  });

  describe("withdrawal", () => {
    it("accepts exactly one SOL withdrawal settlement", async () => {
      await expect(
        validateOuterTransaction(withdrawalPolicy(spendWire(withdrawalInstruction())))
      ).resolves.toBeUndefined();
    });

    it("allows the owner to be the withdrawal recipient without inventing another account", async () => {
      const instruction = withdrawalInstruction(
        opaqueTransactData({ settlements: [{ tag: 1, amount: 10n }] }),
        OWNER
      );

      await expect(
        validateOuterTransaction(withdrawalPolicy(spendWire(instruction), { to: OWNER }))
      ).resolves.toBeUndefined();
    });

    it.each([
      [
        "wrong public recipient",
        () => withdrawalPolicy(spendWire(withdrawalInstruction()), { to: OTHER }),
      ],
      [
        "wrong public amount",
        () =>
          withdrawalPolicy(
            spendWire(
              withdrawalInstruction(opaqueTransactData({ settlements: [{ tag: 1, amount: 11n }] }))
            )
          ),
      ],
      [
        "missing public settlement",
        () =>
          withdrawalPolicy(
            spendWire(withdrawalInstruction(opaqueTransactData({ settlements: [] })))
          ),
      ],
      [
        "SOL deposit instead of withdrawal",
        () =>
          withdrawalPolicy(
            spendWire(
              withdrawalInstruction(opaqueTransactData({ settlements: [{ tag: 0, amount: 10n }] }))
            )
          ),
      ],
      [
        "extra public settlement",
        () =>
          withdrawalPolicy(
            spendWire(
              withdrawalInstruction(
                opaqueTransactData({
                  settlements: [
                    { tag: 1, amount: 10n },
                    { tag: 1, amount: 10n },
                  ],
                })
              )
            )
          ),
      ],
      [
        "extra public recipient account",
        () => {
          const withdrawal = withdrawalInstruction();
          return withdrawalPolicy(
            spendWire({
              ...withdrawal,
              accounts: [
                ...(withdrawal.accounts ?? []),
                { address: OTHER, role: AccountRole.WRITABLE },
              ],
            })
          );
        },
      ],
      [
        "non-SOL requested mint",
        () => withdrawalPolicy(spendWire(withdrawalInstruction()), { mint: MINT }),
      ],
    ])("rejects %s", async (_case, buildInput) => {
      await expectPolicyRejection(buildInput());
    });
  });

  describe("ring-bound spend", () => {
    it("pins the locally derived table to zolana's ringLookupTableAddresses", async () => {
      // The wire gate resolves lookups against this list without RPC; upstream
      // drift must break this build, never custody.
      expect([...(await expectedRingTable(RING_PROGRAM, DEFAULT_TREE_ADDRESS))]).toEqual([
        ...(await ringLookupTableAddresses({
          ringProgramId: RING_PROGRAM,
          tree: DEFAULT_TREE_ADDRESS,
        })),
      ]);
    });

    it("accepts a ring transfer with no public settlement", async () => {
      await expect(
        validateOuterTransaction(ringTransferPolicy(await ringSpendWire(await ringTransfer())))
      ).resolves.toBeUndefined();
    });

    it("accepts a ring withdrawal with exactly the approved settlement", async () => {
      await expect(
        validateOuterTransaction(ringWithdrawalPolicy(await ringSpendWire(await ringWithdrawal())))
      ).resolves.toBeUndefined();
    });

    it.each([
      [
        "the pool transact tag in place of the ring tag",
        async () =>
          ringTransferPolicy(
            await ringSpendWire(await ringTransfer({ data: opaqueTransactData() }))
          ),
      ],
      [
        "a truncated custom-ring proof",
        async () =>
          ringTransferPolicy(
            await ringSpendWire(
              await ringTransfer({
                data: Uint8Array.from([
                  RING_TRANSACT_TAG,
                  ...bytes(CUSTOM_RING_PROOF_LENGTH - 1, 0x33),
                  ...opaqueTransactData().slice(1),
                ]),
              })
            )
          ),
      ],
      [
        "a transact from a ring the intent never named",
        async () =>
          ringTransferPolicy(await ringSpendWire(await ringTransfer()), {
            ring: { programId: OTHER_RING, lookupTable: RING_LOOKUP_TABLE },
          }),
      ],
      [
        "a lookup table that is not the ring's persisted one",
        async () =>
          ringTransferPolicy(await ringSpendWire(await ringTransfer(), { lookupTable: OTHER })),
      ],
      [
        "a default spend intent over compressed bytes",
        async () => transferPolicy(await ringSpendWire(await ringTransfer())),
      ],
      [
        "a non-SOL requested mint",
        async () => ringTransferPolicy(await ringSpendWire(await ringTransfer()), { mint: MINT }),
      ],
      [
        "a public settlement on a ring transfer",
        async () =>
          ringTransferPolicy(
            await ringSpendWire(
              await ringTransfer({
                data: ringTransactData({ settlements: [{ tag: 1, amount: 10n }] }),
              })
            )
          ),
      ],
      [
        "a ring withdrawal amount that differs from the approved one",
        async () =>
          ringWithdrawalPolicy(
            await ringSpendWire(
              await ringWithdrawal({
                data: ringTransactData({ settlements: [{ tag: 1, amount: 11n }] }),
              })
            )
          ),
      ],
      [
        "a ring withdrawal recipient that differs from the approved one",
        async () =>
          ringWithdrawalPolicy(await ringSpendWire(await ringWithdrawal({ recipient: OTHER }))),
      ],
      [
        "an extra writable lookup index nothing references",
        async () =>
          ringTransferPolicy(
            addLookupIndex(await ringSpendWire(await ringTransfer()), "writableIndexes", 6)
          ),
      ],
      [
        "an extra readonly lookup index nothing references",
        async () =>
          ringTransferPolicy(
            addLookupIndex(await ringSpendWire(await ringTransfer()), "readonlyIndexes", 6)
          ),
      ],
      [
        "a lookup index past the table's end",
        async () =>
          ringTransferPolicy(
            addLookupIndex(await ringSpendWire(await ringTransfer()), "readonlyIndexes", 7)
          ),
      ],
      [
        "a duplicated lookup index",
        async () =>
          ringTransferPolicy(
            addLookupIndex(await ringSpendWire(await ringTransfer()), "readonlyIndexes", 0)
          ),
      ],
    ])("rejects %s", async (_case, buildInput) => {
      await expectPolicyRejection(await buildInput());
    });
  });
});
