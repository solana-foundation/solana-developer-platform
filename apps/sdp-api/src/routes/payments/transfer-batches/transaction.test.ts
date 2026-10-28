import type { Address } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { describe, expect, it } from "vitest";
import { syntheticAddress } from "@/test/helpers/parsed-transactions";
import { required } from "@/test/helpers/required";
import {
  TEST_BATCH_FEE_PAYER,
  TEST_BATCH_LIFETIME,
  TEST_BATCH_SOURCE_SIGNER,
  TEST_SPL_TOKEN_CONTEXT,
  testBatchRecipients,
} from "@/test/helpers/transfer-batches";
import {
  buildSplInstructionGroups,
  chunkInstructionGroups,
  deriveDestinationTokenAccounts,
} from "./transaction";

const RENT = 2_039_280n;

const OWNERS = [1, 2, 3, 4, 5].map((index) => syntheticAddress(710 + index));

async function plannedGroups(params: { owners: readonly Address[]; missing: readonly number[] }) {
  const recipients = await deriveDestinationTokenAccounts(
    TEST_SPL_TOKEN_CONTEXT,
    testBatchRecipients(params.owners)
  );
  const accountsAt = (indexes: readonly number[]): Set<Address> =>
    new Set(indexes.map((index) => required(recipients[index]).destinationTokenAccount));
  const missingTokenAccounts = accountsAt(params.missing);
  const groups = buildSplInstructionGroups({
    tokenContext: TEST_SPL_TOKEN_CONTEXT,
    recipients,
    sourceSigner: TEST_BATCH_SOURCE_SIGNER,
    feePayer: TEST_BATCH_FEE_PAYER,
    missingTokenAccounts,
  });
  return { groups, missingTokenAccounts, accountsAt };
}

async function chunkedIndexes(params: {
  owners: readonly Address[];
  missing: readonly number[];
  prefunded: readonly number[];
  maxLamportsPerTransaction: bigint;
  maxRecipientsPerTransaction: number;
}): Promise<number[][]> {
  const { groups, missingTokenAccounts, accountsAt } = await plannedGroups(params);
  return chunkInstructionGroups({
    groups,
    sourceSigner: TEST_BATCH_SOURCE_SIGNER,
    feePayer: TEST_BATCH_FEE_PAYER,
    lifetime: TEST_BATCH_LIFETIME,
    maxRecipientsPerTransaction: params.maxRecipientsPerTransaction,
    rentBudget: {
      maxLamportsPerTransaction: params.maxLamportsPerTransaction,
      rentPerTokenAccount: RENT,
      missingTokenAccounts,
      prefundedTokenAccounts: accountsAt(params.prefunded),
    },
  }).map((chunk) => chunk.recipientIndexes);
}

describe("buildSplInstructionGroups", () => {
  it("creates only the token accounts missing at planning", async () => {
    const { groups } = await plannedGroups({ owners: OWNERS.slice(0, 2), missing: [1] });

    expect(
      groups.map((group) => group.instructions.map((instruction) => instruction.programAddress))
    ).toEqual([[TOKEN_PROGRAM_ADDRESS], [ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS]]);
  });
});

describe("chunkInstructionGroups", () => {
  it.each([
    { label: "exactly two accounts' rent", maxLamportsPerTransaction: 2n * RENT, chunks: [[0, 1]] },
    {
      label: "one lamport under it",
      maxLamportsPerTransaction: 2n * RENT - 1n,
      chunks: [[0], [1]],
    },
  ])("packs two missing accounts against $label", async ({ maxLamportsPerTransaction, chunks }) => {
    expect(
      await chunkedIndexes({
        owners: OWNERS.slice(0, 2),
        missing: [0, 1],
        prefunded: [],
        maxLamportsPerTransaction,
        maxRecipientsPerTransaction: 20,
      })
    ).toEqual(chunks);
  });

  it("fills a chunk with existing accounts up to the recipient cap", async () => {
    expect(
      await chunkedIndexes({
        owners: OWNERS,
        missing: [0, 4],
        prefunded: [],
        maxLamportsPerTransaction: 2_500_000n,
        maxRecipientsPerTransaction: 3,
      })
    ).toEqual([
      [0, 1, 2],
      [3, 4],
    ]);
  });

  it("funds a missing account two recipients share once per chunk", async () => {
    expect(
      await chunkedIndexes({
        owners: [required(OWNERS[0]), required(OWNERS[0])],
        missing: [0],
        prefunded: [],
        maxLamportsPerTransaction: 2_500_000n,
        maxRecipientsPerTransaction: 20,
      })
    ).toEqual([[0, 1]]);
  });

  it("refuses a prefunded token account address before weighing rent", async () => {
    await expect(
      chunkedIndexes({
        owners: OWNERS.slice(0, 3),
        missing: [1],
        prefunded: [2],
        maxLamportsPerTransaction: RENT - 1n,
        maxRecipientsPerTransaction: 20,
      })
    ).rejects.toMatchObject({
      code: "RECIPIENT_NOT_SPONSORABLE",
      statusCode: 422,
      details: { reason: "token_account_address_prefunded", recipientIndexes: [2] },
    });
  });

  it("refuses every recipient whose new account alone exceeds the limit", async () => {
    await expect(
      chunkedIndexes({
        owners: OWNERS.slice(0, 3),
        missing: [1, 2],
        prefunded: [],
        maxLamportsPerTransaction: RENT - 1n,
        maxRecipientsPerTransaction: 20,
      })
    ).rejects.toMatchObject({
      code: "RECIPIENT_NOT_SPONSORABLE",
      statusCode: 422,
      details: {
        reason: "rent_exceeds_limit",
        recipientIndexes: [1, 2],
        rentLamportsPerTokenAccount: RENT.toString(),
        maxSponsoredLamportsPerTransaction: (RENT - 1n).toString(),
      },
    });
  });

  it("chunks under the same limit when no account is missing", async () => {
    expect(
      await chunkedIndexes({
        owners: OWNERS.slice(0, 3),
        missing: [],
        prefunded: [],
        maxLamportsPerTransaction: RENT - 1n,
        maxRecipientsPerTransaction: 20,
      })
    ).toEqual([[0, 1, 2]]);
  });
});
