import { address, blockhash, createNoopSigner } from "@solana/kit";
import * as MosaicSdk from "@solana/mosaic-sdk";
import { AuthorityType } from "@solana-program/token-2022";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAuthorityTransaction } from "../../../../../../packages/sdp-issuance/src/mosaic/authority";

const mint = address("DUbbr2Ps6xCSuQfQFLaKVpyPZJgnbCSka5zLmeinDmP9");
const currentAuthority = createNoopSigner(address("8NjftgbiNJbaNZRYYXDAZ5SFRBTRg3is9eue1g5RW8m1"));
const newAuthority = address("7W6EveEXJ3tiypniAr6Ug7xvhRAnDJ7gyUQF7NyZqtvi");
type AuthorityInput = Parameters<typeof buildAuthorityTransaction>[0];
const rpc = { getLatestBlockhash: vi.fn() } as unknown as AuthorityInput["rpc"];
const input: AuthorityInput = {
  rpc,
  mint,
  currentAuthority,
  payer: currentAuthority,
  newAuthority,
  role: AuthorityType.FreezeAccount,
};

afterEach(() => vi.restoreAllMocks());

describe("freeze authority routing", () => {
  function mockMint(usesTokenAcl: boolean) {
    return vi
      .spyOn(MosaicSdk, "getMintDetails")
      .mockResolvedValue({ usesTokenAcl } as Awaited<ReturnType<typeof MosaicSdk.getMintDetails>>);
  }

  it("updates the ACL controller instead of replacing the mint's PDA authority", async () => {
    mockMint(true);
    vi.spyOn(rpc, "getLatestBlockhash").mockReturnValue({
      reactiveStore: vi.fn(),
      send: vi.fn().mockResolvedValue({
        value: {
          blockhash: blockhash("11111111111111111111111111111111"),
          lastValidBlockHeight: 100n,
        },
      }),
    });
    const standard = vi.spyOn(MosaicSdk, "getUpdateAuthorityTransaction");
    const transaction = await buildAuthorityTransaction(input);
    expect(standard).not.toHaveBeenCalled();
    expect(transaction.instructions).toHaveLength(1);
    expect(transaction.instructions[0].programAddress).toBe(MosaicSdk.TOKEN_ACL_PROGRAM_ID);
    expect(transaction.instructions[0].accounts?.map((account) => account.address)).toEqual([
      currentAuthority.address,
      "H9LZav3PsF2uCYej368x8EgRhNibBBSCYSaxgBJJt4Cs",
    ]);
    expect(transaction.instructions[0].data?.[0]).toBe(1);
  });

  it("rejects removing an ACL controller before signing", async () => {
    mockMint(true);
    const remove = vi.spyOn(MosaicSdk, "getRemoveAuthorityTransaction");
    await expect(buildAuthorityTransaction({ ...input, newAuthority: null })).rejects.toThrow(
      "cannot be removed"
    );
    expect(remove).not.toHaveBeenCalled();
  });

  it("preserves standard freeze authority reassignment", async () => {
    mockMint(false);
    const standard = vi
      .spyOn(MosaicSdk, "getUpdateAuthorityTransaction")
      .mockResolvedValue({} as Awaited<ReturnType<typeof MosaicSdk.getUpdateAuthorityTransaction>>);
    await buildAuthorityTransaction(input);
    expect(standard).toHaveBeenCalledWith(input);
  });

  it("preserves mint authority removal without an ACL lookup", async () => {
    const lookup = vi.spyOn(MosaicSdk, "getMintDetails");
    const remove = vi
      .spyOn(MosaicSdk, "getRemoveAuthorityTransaction")
      .mockResolvedValue({} as Awaited<ReturnType<typeof MosaicSdk.getRemoveAuthorityTransaction>>);
    const removal: AuthorityInput = {
      ...input,
      role: AuthorityType.MintTokens,
      newAuthority: null,
    };
    await buildAuthorityTransaction(removal);
    expect(lookup).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith(removal);
  });
});
