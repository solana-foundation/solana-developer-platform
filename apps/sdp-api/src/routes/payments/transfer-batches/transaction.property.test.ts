import { formatDecimalAmount, parseDecimalAmount } from "@sdp/solana/amount";
import { MEMO_PROGRAM_ADDRESS } from "@sdp/types/well-known-programs";
import { SOL_MINT, SPL_TOKEN_PROGRAMS } from "@sdp/types/well-known-tokens";
import {
  type Address,
  address,
  blockhash,
  compileTransaction,
  createNoopSigner,
  getAddressDecoder,
  type Instruction,
  isTransactionWithinSizeLimit,
} from "@solana/kit";
import {
  getTransferSolInstructionDataDecoder,
  identifySystemInstruction,
  SYSTEM_PROGRAM_ADDRESS,
  SystemInstruction,
} from "@solana-program/system";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  AssociatedTokenInstruction,
  findAssociatedTokenPda,
  getTransferCheckedInstructionDataDecoder,
  identifyAssociatedTokenInstruction,
  identifyToken2022Instruction,
  Token2022Instruction,
} from "@solana-program/token-2022";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { propertyParameters } from "@/test/helpers/property";
import {
  buildInstructionGroups,
  chunkInstructionGroups,
  type RecipientInstructionGroup,
} from "./transaction";
import type { ResolvedRecipient, TokenContext } from "./types";

/**
 * Property tests (STRIDE P5.4) for the batch transfer builder: whatever the
 * recipients, amounts, decimals and per-transaction cap, the instructions it
 * signs move exactly what the request names, to whom it names, once each.
 */

const U64_MAX = 2n ** 64n - 1n;
const SOURCE = address(TEST_SOLANA_ADDRESSES.wallet1);
const FEE_PAYER = address(TEST_SOLANA_ADDRESSES.wallet2);
const MINT = address(TEST_SOLANA_ADDRESSES.mint);
const SOURCE_TOKEN_ACCOUNT = address(TEST_SOLANA_ADDRESSES.wallet3);
const LIFETIME = {
  blockhash: blockhash("EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N"),
  lastValidBlockHeight: 1_000n,
};
const sourceSigner = createNoopSigner(SOURCE);
const addressDecoder = getAddressDecoder();

const addressArb: fc.Arbitrary<Address> = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((bytes) => addressDecoder.decode(bytes));

const tokenContextArb: fc.Arbitrary<TokenContext> = fc.oneof(
  fc.constant<TokenContext>({
    kind: "sol",
    token: SOL_MINT,
    decimals: 9,
    toBaseUnits: () => {
      throw new Error("not used by the builder");
    },
  }),
  fc
    .record({
      decimals: fc.integer({ min: 0, max: 18 }),
      tokenProgram: fc.constantFrom(
        address(SPL_TOKEN_PROGRAMS["spl-token"]),
        address(SPL_TOKEN_PROGRAMS["token-2022"])
      ),
    })
    .map(
      ({ decimals, tokenProgram }): TokenContext => ({
        kind: "spl",
        token: MINT,
        decimals,
        mintAddress: MINT,
        tokenProgram,
        sourceTokenAccount: SOURCE_TOKEN_ACCOUNT,
        toBaseUnits: () => {
          throw new Error("not used by the builder");
        },
      })
    )
);

const amountArb = fc.oneof(
  fc.bigInt({ min: 1n, max: U64_MAX }),
  fc.bigInt({ min: 1n, max: 1_000_000n }),
  fc.constant(U64_MAX)
);

/** Recipients as `resolveBatchRecipients` hands them over: amounts canonical at the mint's decimals. */
function recipientsArb(decimals: number): fc.Arbitrary<ResolvedRecipient[]> {
  return fc
    .array(fc.record({ destination: addressArb, amount: amountArb }), {
      minLength: 1,
      maxLength: 45,
    })
    .map((entries) =>
      entries.map(({ destination, amount }, index) => ({
        index,
        externalId: null,
        counterpartyId: `cp_${index}`,
        counterpartyAccountId: `cpa_${index}`,
        destinationAddress: destination,
        amount: formatDecimalAmount(amount, decimals),
        amountBaseUnits: amount,
      }))
    );
}

const batchArb = tokenContextArb.chain((tokenContext) =>
  fc.record({
    tokenContext: fc.constant(tokenContext),
    recipients: recipientsArb(tokenContext.decimals),
    maxRecipientsPerTransaction: fc.integer({ min: 1, max: 25 }),
  })
);

interface DecodedTransfer {
  destination: Address;
  amount: bigint;
}

/** An instruction's accounts and data, which every instruction the builder emits carries. */
function parts(instruction: Instruction) {
  const { accounts, data } = instruction;
  if (accounts === undefined || data === undefined) {
    throw new Error(`${instruction.programAddress} instruction without accounts or data`);
  }
  return { accounts, data };
}

/**
 * Reads every value-moving instruction back from its bytes and accounts, and
 * fails on any instruction the batch builder has no reason to emit.
 */
function decodeTransfers(
  instructions: readonly Instruction[],
  tokenContext: TokenContext
): DecodedTransfer[] {
  const transfers: DecodedTransfer[] = [];
  for (const instruction of instructions) {
    const { accounts, data } = parts(instruction);
    if (instruction.programAddress === MEMO_PROGRAM_ADDRESS) {
      expect(accounts).toHaveLength(0);
      continue;
    }
    if (tokenContext.kind === "sol") {
      expect(instruction.programAddress).toBe(SYSTEM_PROGRAM_ADDRESS);
      expect(identifySystemInstruction(data)).toBe(SystemInstruction.TransferSol);
      expect(accounts[0]?.address).toBe(SOURCE);
      transfers.push({
        destination: accounts[1].address,
        amount: getTransferSolInstructionDataDecoder().decode(data).amount,
      });
      continue;
    }
    if (instruction.programAddress === ASSOCIATED_TOKEN_PROGRAM_ADDRESS) {
      expect(identifyAssociatedTokenInstruction(data)).toBe(
        AssociatedTokenInstruction.CreateAssociatedTokenIdempotent
      );
      continue;
    }
    expect(instruction.programAddress).toBe(tokenContext.tokenProgram);
    expect(identifyToken2022Instruction(data)).toBe(Token2022Instruction.TransferChecked);
    const decoded = getTransferCheckedInstructionDataDecoder().decode(data);
    // source, mint, destination, authority
    expect(accounts[0]?.address).toBe(tokenContext.sourceTokenAccount);
    expect(accounts[1]?.address).toBe(tokenContext.mintAddress);
    expect(accounts[3]?.address).toBe(SOURCE);
    expect(decoded.decimals).toBe(tokenContext.decimals);
    transfers.push({ destination: accounts[2].address, amount: decoded.amount });
  }
  return transfers;
}

/** The token accounts the instructions create: `[{ account, owner, mint }]`, in order. */
function decodeCreatedAccounts(instructions: readonly Instruction[]) {
  return instructions
    .filter((instruction) => instruction.programAddress === ASSOCIATED_TOKEN_PROGRAM_ADDRESS)
    .map((instruction) => {
      // payer, ata, owner, mint, system program, token program
      const { accounts } = parts(instruction);
      return {
        account: accounts[1].address,
        owner: accounts[2].address,
        mint: accounts[3].address,
      };
    });
}

/**
 * Where a recipient's value must land, derived from the request rather than
 * the builder: its wallet for SOL, the wallet's associated token account for SPL.
 */
async function expectedLanding(
  recipient: ResolvedRecipient,
  tokenContext: TokenContext
): Promise<Address> {
  if (tokenContext.kind === "sol") return recipient.destinationAddress;
  const [account] = await findAssociatedTokenPda({
    owner: recipient.destinationAddress,
    mint: tokenContext.mintAddress,
    tokenProgram: tokenContext.tokenProgram,
  });
  return account;
}

function build(params: {
  tokenContext: TokenContext;
  recipients: ResolvedRecipient[];
}): Promise<RecipientInstructionGroup[]> {
  return buildInstructionGroups({ ...params, sourceSigner, feePayer: FEE_PAYER });
}

function chunk(groups: RecipientInstructionGroup[], maxRecipientsPerTransaction: number) {
  return chunkInstructionGroups({
    groups,
    sourceSigner,
    feePayer: FEE_PAYER,
    lifetime: LIFETIME,
    maxRecipientsPerTransaction,
  });
}

/**
 * What an instruction asks the chain to do (program, accounts and roles,
 * data), without the signer objects attached to its accounts.
 */
function wireForm(instructions: readonly Instruction[]) {
  return instructions.map((instruction) => ({
    programAddress: instruction.programAddress,
    accounts: parts(instruction).accounts.map(({ address, role }) => ({ address, role })),
    data: [...parts(instruction).data],
  }));
}

/** A group's wire form, for comparing two builds. */
function groupWireForm(group: RecipientInstructionGroup) {
  const { instructions, ...recipient } = group;
  return { ...recipient, instructions: wireForm(instructions) };
}

/** Instructions without the per-chunk random memo, for comparing two builds. */
function withoutMemo(instructions: readonly Instruction[]) {
  return wireForm(
    instructions.filter((instruction) => instruction.programAddress !== MEMO_PROGRAM_ADDRESS)
  );
}

describe("batch transfer builder (property)", () => {
  it("emits one transfer per recipient for exactly its amount and destination", async () => {
    await fc.assert(
      fc.asyncProperty(batchArb, async ({ tokenContext, recipients }) => {
        const groups = await build({ tokenContext, recipients });
        expect(groups.map((group) => group.index)).toEqual(recipients.map((r) => r.index));
        for (const [position, group] of groups.entries()) {
          const recipient = recipients[position];
          const landing = await expectedLanding(recipient, tokenContext);
          expect(decodeTransfers(group.instructions, tokenContext)).toEqual([
            { destination: landing, amount: recipient.amountBaseUnits },
          ]);
          expect(decodeCreatedAccounts(group.instructions)).toEqual(
            tokenContext.kind === "sol"
              ? []
              : [{ account: landing, owner: recipient.destinationAddress, mint: MINT }]
          );
        }
      }),
      propertyParameters()
    );
  });

  it("packs every recipient exactly once, in order, within the cap and the size limit", async () => {
    await fc.assert(
      fc.asyncProperty(
        batchArb,
        async ({ tokenContext, recipients, maxRecipientsPerTransaction }) => {
          const groups = await build({ tokenContext, recipients });
          const chunks = chunk(groups, maxRecipientsPerTransaction);

          expect(chunks.flatMap((c) => c.recipientIndexes)).toEqual(
            recipients.map((recipient) => recipient.index)
          );
          for (const c of chunks) {
            expect(c.recipientIndexes.length).toBeGreaterThan(0);
            expect(c.recipientIndexes.length).toBeLessThanOrEqual(maxRecipientsPerTransaction);
            expect(isTransactionWithinSizeLimit(compileTransaction(c.message))).toBe(true);
          }
        }
      ),
      propertyParameters({ numRuns: 50 })
    );
  });

  it("conserves value: each chunk moves exactly its recorded amount, the batch exactly its total", async () => {
    await fc.assert(
      fc.asyncProperty(
        batchArb,
        async ({ tokenContext, recipients, maxRecipientsPerTransaction }) => {
          const groups = await build({ tokenContext, recipients });
          const expected = new Map(
            await Promise.all(
              recipients.map(
                async (recipient) =>
                  [
                    recipient.index,
                    {
                      destination: await expectedLanding(recipient, tokenContext),
                      amount: recipient.amountBaseUnits,
                    },
                  ] as const
              )
            )
          );
          const chunks = chunk(groups, maxRecipientsPerTransaction);

          let batchMoved = 0n;
          for (const c of chunks) {
            const transfers = decodeTransfers(c.instructions, tokenContext);
            // The signed message carries the same instructions the chunk records.
            expect(c.message.instructions).toEqual(c.instructions);
            expect(transfers).toEqual(
              c.recipientIndexes.map((index) => {
                const transfer = expected.get(index);
                if (transfer === undefined) throw new Error(`unknown recipient ${index}`);
                return transfer;
              })
            );
            const moved = transfers.reduce((sum, transfer) => sum + transfer.amount, 0n);
            expect(parseDecimalAmount(c.amount, tokenContext.decimals)).toBe(moved);
            batchMoved += moved;
          }
          expect(batchMoved).toBe(
            recipients.reduce((sum, recipient) => sum + recipient.amountBaseUnits, 0n)
          );
        }
      ),
      propertyParameters({ numRuns: 50 })
    );
  });

  it("builds the same instructions for a recipient wherever it sits in the request", async () => {
    await fc.assert(
      fc.asyncProperty(
        batchArb.chain((batch) =>
          fc.tuple(
            fc.constant(batch),
            fc.shuffledSubarray(batch.recipients, { minLength: batch.recipients.length })
          )
        ),
        async ([{ tokenContext, recipients, maxRecipientsPerTransaction }, shuffled]) => {
          const first = await build({ tokenContext, recipients });
          const again = await build({ tokenContext, recipients });
          const reordered = await build({ tokenContext, recipients: shuffled });

          expect(again.map(groupWireForm)).toEqual(first.map(groupWireForm));
          const byIndex = new Map(reordered.map((group) => [group.index, groupWireForm(group)]));
          for (const group of first) expect(byIndex.get(group.index)).toEqual(groupWireForm(group));

          // Chunking is deterministic too, apart from the per-chunk uniqueness memo.
          const chunksA = chunk(first, maxRecipientsPerTransaction);
          const chunksB = chunk(again, maxRecipientsPerTransaction);
          expect(chunksB.map((c) => c.recipientIndexes)).toEqual(
            chunksA.map((c) => c.recipientIndexes)
          );
          expect(chunksB.map((c) => withoutMemo(c.instructions))).toEqual(
            chunksA.map((c) => withoutMemo(c.instructions))
          );
        }
      ),
      propertyParameters({ numRuns: 50 })
    );
  });
});
