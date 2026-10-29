import { createClusterRpc } from "@sdp/rpc/factory";
import { runInClusterScope } from "@sdp/rpc/scope";
import { type Address, address, type Blockhash, createNoopSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { extension, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { installClusterRpcResponder } from "@/test/helpers/cluster-rpc";
import { syntheticAddress } from "@/test/helpers/parsed-transactions";
import { respondTokenAccounts, type StubMint } from "@/test/helpers/token-mints";
import { readSponsoredRentLimit } from "./sponsored-rent";
import {
  buildInstructionGroups,
  chunkInstructionGroups,
  DEFAULT_MAX_RECIPIENTS_PER_TRANSACTION,
  type RecipientInstructionGroup,
  type SponsoredRentLimit,
} from "./transaction";
import type { ResolvedRecipient, TokenContext } from "./types";

/** HOO-2024's figure for a 165-byte token account (the chain answered 1,488,440 on 2026-10-29). */
const LEGACY_TOKEN_ACCOUNT_RENT = 2_039_280n;
const KORA_CAP = 2_500_000n;
const SOURCE = createNoopSigner(syntheticAddress(1));
const FEE_PAYER = syntheticAddress(2);
const LIFETIME = {
  blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N" as Blockhash,
  lastValidBlockHeight: 1000n,
};

function tokenContext(tokenProgram: Address, mintAddress: Address): TokenContext {
  return {
    kind: "spl",
    token: mintAddress,
    decimals: 6,
    mintAddress,
    tokenProgram,
    sourceTokenAccount: syntheticAddress(3),
    toBaseUnits: (amount) => BigInt(amount),
  };
}

function recipients(count: number): ResolvedRecipient[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    externalId: null,
    counterpartyId: `cp_${index}`,
    counterpartyAccountId: `cpa_${index}`,
    destinationAddress: syntheticAddress(100 + index),
    amount: "1",
    amountBaseUnits: 1_000_000n,
  }));
}

function destinationTokenAccounts(groups: RecipientInstructionGroup[]): Set<string> {
  return new Set(groups.flatMap((group) => group.destinationTokenAccount ?? []));
}

/** The rent of every chunk: each created token account it names, once. */
function chunkRent(
  chunk: { recipientIndexes: number[] },
  groups: RecipientInstructionGroup[],
  limit: SponsoredRentLimit
): bigint {
  const created = new Set(
    chunk.recipientIndexes.flatMap((index) => groups[index].destinationTokenAccount ?? [])
  );
  let total = 0n;
  for (const account of created) total += limit.rentByTokenAccount.get(account) ?? 0n;
  return total;
}

describe("batch chunks under the sponsor's rent cap (HOO-2024)", () => {
  const rpc = installClusterRpcResponder();
  const readConfiguration = vi.fn(async () => ({
    signerAddress: FEE_PAYER,
    maxAllowedLamports: KORA_CAP,
    feePayerMayTransferLamports: false,
    feePayerPolicy: {},
  }));
  const rentSizes = () =>
    rpc.requests
      .filter((request) => request.method === "getMinimumBalanceForRentExemption")
      .map((request) => z.number().parse(request.params[0]));
  const accountReads = () =>
    rpc.requests.filter((request) => request.method === "getMultipleAccounts");

  let hoursAhead = 0;
  beforeEach(() => {
    readConfiguration.mockClear();
    vi.useFakeTimers({ toFake: ["Date"] });
    // Past the hour every earlier test cached a rent minimum for.
    hoursAhead += 2;
    vi.setSystemTime(Date.now() + hoursAhead * 60 * 60 * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function plan(
    context: TokenContext,
    count: number,
    rpcSetup: (groups: Set<string>) => void
  ) {
    const groups = await buildInstructionGroups({
      tokenContext: context,
      recipients: recipients(count),
      sourceSigner: SOURCE,
      feePayer: FEE_PAYER,
    });
    rpcSetup(destinationTokenAccounts(groups));
    return runInClusterScope({ projectId: null, environment: "sandbox" }, async () => {
      const sponsoredRent = await readSponsoredRentLimit({
        rpc: createClusterRpc(),
        groups,
        tokenContext: context,
        readConfiguration,
      });
      const chunks = chunkInstructionGroups({
        groups,
        sourceSigner: SOURCE,
        feePayer: FEE_PAYER,
        lifetime: LIFETIME,
        maxRecipientsPerTransaction: DEFAULT_MAX_RECIPIENTS_PER_TRANSACTION,
        sponsoredRent,
      });
      return { groups, sponsoredRent, chunks };
    });
  }

  it("puts one new token account in each chunk when two would pass the cap", async () => {
    rpc.answer("getMinimumBalanceForRentExemption", Number(LEGACY_TOKEN_ACCOUNT_RENT));
    const { groups, sponsoredRent, chunks } = await plan(
      tokenContext(TOKEN_PROGRAM_ADDRESS, syntheticAddress(10)),
      5,
      (tokenAccounts) =>
        respondTokenAccounts(rpc, { tokenProgram: TOKEN_PROGRAM_ADDRESS, missing: tokenAccounts })
    );

    expect(chunks.map((chunk) => chunk.recipientIndexes)).toEqual([[0], [1], [2], [3], [4]]);
    for (const chunk of chunks) {
      expect(chunkRent(chunk, groups, sponsoredRent)).toBe(LEGACY_TOKEN_ACCOUNT_RENT);
      expect(chunkRent(chunk, groups, sponsoredRent)).toBeLessThanOrEqual(KORA_CAP);
    }
    // RPC: one getMultipleAccounts for the plan, one rent read, one Kora config read.
    expect(accountReads()).toHaveLength(1);
    expect(rentSizes()).toEqual([165]);
    expect(readConfiguration).toHaveBeenCalledTimes(1);
  });

  it("packs recipients whose token accounts exist by count and size alone", async () => {
    const { groups, chunks } = await plan(
      tokenContext(TOKEN_PROGRAM_ADDRESS, syntheticAddress(10)),
      20,
      () => respondTokenAccounts(rpc, { tokenProgram: TOKEN_PROGRAM_ADDRESS })
    );
    const bySizeAlone = chunkInstructionGroups({
      groups,
      sourceSigner: SOURCE,
      feePayer: FEE_PAYER,
      lifetime: LIFETIME,
      maxRecipientsPerTransaction: DEFAULT_MAX_RECIPIENTS_PER_TRANSACTION,
      sponsoredRent: { rentByTokenAccount: new Map(), capLamports: null },
    });

    // Every group still carries its idempotent create, so 20 recipients pass the 1,232-byte limit
    // and split by size (HOO-2313 drops the create for an existing account); rent splits nothing.
    expect(chunks.map((chunk) => chunk.recipientIndexes)).toEqual(
      bySizeAlone.map((chunk) => chunk.recipientIndexes)
    );
    expect(chunks.flatMap((chunk) => chunk.recipientIndexes)).toHaveLength(20);
    // Nothing is created, so neither rent nor the cap is read.
    expect(accountReads()).toHaveLength(1);
    expect(rentSizes()).toEqual([]);
    expect(readConfiguration).not.toHaveBeenCalled();
  });

  it("prices each token account by its mint's size, from the chain", async () => {
    // Any rent the stub could answer: proportional to size, never a constant.
    rpc.respond("getMinimumBalanceForRentExemption", (request) => ({
      result: z.number().parse(request.params[0]) * 1_000,
    }));
    const legacyMint = syntheticAddress(10);
    const extendedMint = syntheticAddress(11);
    const extended: StubMint = {
      decimals: 6,
      extensions: [
        extension("TransferFeeConfig", {
          transferFeeConfigAuthority: syntheticAddress(12),
          withdrawWithheldAuthority: syntheticAddress(13),
          withheldAmount: 0n,
          olderTransferFee: { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: 0 },
          newerTransferFee: { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: 0 },
        }),
        extension("TransferHook", {
          authority: syntheticAddress(14),
          programId: syntheticAddress(15),
        }),
        extension("PermanentDelegate", { delegate: syntheticAddress(16) }),
      ],
    };

    const legacy = await plan(tokenContext(TOKEN_PROGRAM_ADDRESS, legacyMint), 1, (accounts) =>
      respondTokenAccounts(rpc, { tokenProgram: TOKEN_PROGRAM_ADDRESS, missing: accounts })
    );
    const token2022 = await plan(
      tokenContext(TOKEN_2022_PROGRAM_ADDRESS, extendedMint),
      1,
      (accounts) =>
        respondTokenAccounts(rpc, {
          tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
          mints: new Map([[extendedMint, extended]]),
          missing: accounts,
        })
    );

    // 165 base bytes; Token-2022 adds the account type, ImmutableOwner (4), TransferFeeAmount
    // (4 + 8) and TransferHookAccount (4 + 1). PermanentDelegate needs no account extension.
    expect(rentSizes()).toEqual([165, 187]);
    expect([...legacy.sponsoredRent.rentByTokenAccount.values()]).toEqual([165_000n]);
    expect([...token2022.sponsoredRent.rentByTokenAccount.values()]).toEqual([187_000n]);
    // The Token-2022 mint is read in the same getMultipleAccounts as the recipient's account.
    expect(
      accountReads().map((request) => z.array(z.string()).parse(request.params[0])[0])
    ).toEqual([legacy.groups[0].destinationTokenAccount, extendedMint]);
  });

  it("refuses a recipient whose token account alone costs more than the cap", async () => {
    rpc.answer("getMinimumBalanceForRentExemption", Number(KORA_CAP + 1n));

    const planned = plan(tokenContext(TOKEN_PROGRAM_ADDRESS, syntheticAddress(10)), 2, (accounts) =>
      respondTokenAccounts(rpc, { tokenProgram: TOKEN_PROGRAM_ADDRESS, missing: accounts })
    );

    await expect(planned).rejects.toBeInstanceOf(AppError);
    await expect(planned).rejects.toMatchObject({
      code: "SPONSORED_RENT_OVER_CAP",
      details: { recipientIndex: 0, capLamports: KORA_CAP.toString() },
    });
  });

  it("counts an address holding lamports but no token account as created", async () => {
    rpc.answer("getMinimumBalanceForRentExemption", Number(LEGACY_TOKEN_ACCOUNT_RENT));

    const { sponsoredRent } = await plan(
      tokenContext(TOKEN_PROGRAM_ADDRESS, syntheticAddress(10)),
      1,
      // A wallet-shaped account: owned by the system program, not the token program.
      () => respondTokenAccounts(rpc, { tokenProgram: address("11111111111111111111111111111111") })
    );

    expect(sponsoredRent.rentByTokenAccount.size).toBe(1);
  });
});
