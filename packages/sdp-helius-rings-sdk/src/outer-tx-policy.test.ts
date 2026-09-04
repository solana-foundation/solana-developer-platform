import { getAssociatedTokenAddress } from "@heliuslabs/zolana/addresses";
import {
  DEFAULT_TREE_ADDRESS,
  DepositAsset,
  depositInstruction,
  SHIELDED_POOL_PROGRAM_ID,
  SOL_INTERFACE,
  SPL_TOKEN_PROGRAM_ID,
} from "@heliuslabs/zolana/interface";
import {
  AccountRole,
  type Address,
  address,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
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
import { type OuterTransactionPolicyInput, validateOuterTransaction } from "./outer-tx-policy.js";

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
});
