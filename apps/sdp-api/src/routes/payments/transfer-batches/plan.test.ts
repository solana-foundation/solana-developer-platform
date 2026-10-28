import { runInClusterScope } from "@sdp/rpc/scope";
import type { Address } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { installClusterRpcResponder } from "@/test/helpers/cluster-rpc";
import { syntheticAddress } from "@/test/helpers/parsed-transactions";
import { required } from "@/test/helpers/required";
import { respondRecipientTokenAccounts } from "@/test/helpers/token-mints";
import {
  TEST_BATCH_FEE_PAYER,
  TEST_BATCH_LIFETIME,
  TEST_BATCH_SOURCE_SIGNER,
  TEST_SPL_TOKEN_CONTEXT,
  testBatchRecipients,
} from "@/test/helpers/transfer-batches";
import { planBatchTransactions } from "./plan";

const INITIALIZED_OWNER = syntheticAddress(721);
const MISSING_OWNER = syntheticAddress(722);

async function associatedTokenAccount(owner: Address): Promise<Address> {
  const [tokenAccount] = await findAssociatedTokenPda({
    owner,
    mint: TEST_SPL_TOKEN_CONTEXT.mintAddress,
    tokenProgram: TEST_SPL_TOKEN_CONTEXT.tokenProgram,
  });
  return tokenAccount;
}

function plan(owners: readonly Address[]) {
  return runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
    planBatchTransactions({
      tokenContext: TEST_SPL_TOKEN_CONTEXT,
      recipients: testBatchRecipients(owners),
      sourceSigner: TEST_BATCH_SOURCE_SIGNER,
      feePayer: TEST_BATCH_FEE_PAYER,
      lifetime: TEST_BATCH_LIFETIME,
      maxRecipientsPerTransaction: 20,
      maxSponsoredLamportsPerTransaction: 2_500_000n,
    })
  );
}

describe("planBatchTransactions", () => {
  const rpc = installClusterRpcResponder();

  async function respondTokenAccounts(): Promise<void> {
    await respondRecipientTokenAccounts(rpc, {
      mint: TEST_SPL_TOKEN_CONTEXT.mintAddress,
      tokenProgram: TEST_SPL_TOKEN_CONTEXT.tokenProgram,
      holders: [INITIALIZED_OWNER],
      prefunded: [],
    });
  }

  it("funds rent only for the recipient whose token account is missing", async () => {
    await respondTokenAccounts();
    const missingTokenAccount = await associatedTokenAccount(MISSING_OWNER);

    const { chunks, rentBudget } = await plan([INITIALIZED_OWNER, MISSING_OWNER]);

    expect(rentBudget).toEqual({
      maxLamportsPerTransaction: 2_500_000n,
      rentPerTokenAccount: 2_039_280n,
      missingTokenAccounts: new Set([missingTokenAccount]),
      prefundedTokenAccounts: new Set(),
    });
    expect(chunks.map((chunk) => chunk.recipientIndexes)).toEqual([[0, 1]]);
  });

  it("reads 101 recipient token accounts in slices of 100 and 1", async () => {
    const owners = Array.from({ length: 101 }, (_, index) => syntheticAddress(800 + index));
    await respondRecipientTokenAccounts(rpc, {
      mint: TEST_SPL_TOKEN_CONTEXT.mintAddress,
      tokenProgram: TEST_SPL_TOKEN_CONTEXT.tokenProgram,
      holders: owners.slice(0, 100),
      prefunded: [],
    });

    const { rentBudget } = await plan(owners);

    expect(
      rpc.requests
        .filter((request) => request.method === "getMultipleAccounts")
        .map((request) => z.array(z.string()).parse(request.params[0]).length)
    ).toEqual([100, 1]);
    expect(rentBudget.missingTokenAccounts).toEqual(
      new Set([await associatedTokenAccount(required(owners[100]))])
    );
  });

  it("answers 502 when getMultipleAccounts answers for fewer addresses than asked", async () => {
    await respondTokenAccounts();
    rpc.respond("getMultipleAccounts", () => ({ result: { context: { slot: 1 }, value: [] } }));

    await expect(plan([MISSING_OWNER])).rejects.toMatchObject({
      code: "SOLANA_RPC_ERROR",
      statusCode: 502,
    });
  });
});
