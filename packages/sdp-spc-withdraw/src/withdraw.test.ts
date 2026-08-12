import { type Address, address, createNoopSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  getWithdrawFundsInstructionAsync,
  PRIVATE_CHANNEL_WITHDRAW_PROGRAM_ADDRESS,
  WITHDRAW_FUNDS_DISCRIMINATOR,
} from "./index";

// Real deployed devnet withdraw program + sandbox mint + a sample destination.
const WITHDRAW_PROGRAM = "J231K9UEpS4y4KAPwGc4gsMNCjKFRMYcQBcjVW7vBhVi";
const CLASSIC_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const MINT = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const USER = address("7C1Pu8mbHaDDTFnGH8YTqemNDofqXP3XEotzSo6TbwHz");
const DESTINATION = address("J231K9UEpS4y4KAPwGc4gsMNCjKFRMYcQBcjVW7vBhVi");

async function buildWithdraw(destination: Address | null = null) {
  return getWithdrawFundsInstructionAsync({
    user: createNoopSigner(USER),
    mint: MINT,
    amount: 1_000_000n,
    destination,
  });
}

async function expectedAta(tokenProgram: string) {
  const { getProgramDerivedAddress, getAddressEncoder } = await import("@solana/kit");
  const [ata] = await getProgramDerivedAddress({
    programAddress: address(ATA_PROGRAM),
    seeds: [
      getAddressEncoder().encode(USER),
      getAddressEncoder().encode(address(tokenProgram)),
      getAddressEncoder().encode(MINT),
    ],
  });
  return ata;
}

describe("withdraw withdrawFunds instruction", () => {
  it("targets the real deployed program (J231K9…), already declared in the IDL", async () => {
    expect(PRIVATE_CHANNEL_WITHDRAW_PROGRAM_ADDRESS).toBe(WITHDRAW_PROGRAM);
    const ix = await buildWithdraw();
    expect(ix.programAddress).toBe(WITHDRAW_PROGRAM);
  });

  it("has 5 ordered accounts and the burn discriminator (0) as the first data byte", async () => {
    const ix = await buildWithdraw();
    expect(ix.accounts).toHaveLength(5);
    expect(WITHDRAW_FUNDS_DISCRIMINATOR).toBe(0);
    expect(ix.data?.[0]).toBe(0);
  });

  it("orders accounts user, mint, tokenAccount, classic tokenProgram, associatedTokenProgram", async () => {
    const ix = await buildWithdraw();
    // Account order: user, mint, tokenAccount, tokenProgram, associatedTokenProgram.
    expect(ix.accounts[0]?.address).toBe(USER);
    expect(ix.accounts[1]?.address).toBe(MINT);
    expect(ix.accounts[3]?.address).toBe(CLASSIC_TOKEN_PROGRAM);
    expect(ix.accounts[4]?.address).toBe(ATA_PROGRAM);
  });

  it("derives tokenAccount as the user's classic-Token ATA", async () => {
    const ix = await buildWithdraw();
    expect(ix.accounts[2]?.address).toBe(await expectedAta(CLASSIC_TOKEN_PROGRAM));
  });

  it("passing the classic program explicitly matches leaving it defaulted", async () => {
    // The burn path now always passes `tokenProgram` rather than relying on the
    // generated default. This is the guard that threading it did not move the
    // account a working classic-USDC withdrawal burns from.
    const defaulted = await buildWithdraw();
    const explicit = await getWithdrawFundsInstructionAsync({
      user: createNoopSigner(USER),
      mint: MINT,
      tokenProgram: address(CLASSIC_TOKEN_PROGRAM),
      amount: 1_000_000n,
      destination: null,
    });
    expect(explicit.accounts.map((account) => account.address)).toEqual(
      defaulted.accounts.map((account) => account.address)
    );
    expect(explicit.data).toEqual(defaulted.data);
  });

  it("derives tokenAccount under token-2022 when that program owns the mint", async () => {
    // spl-token and token-2022 seed DIFFERENT ATAs for the same (user, mint), so a
    // hardcoded classic assumption would burn from an account that holds nothing.
    const ix = await getWithdrawFundsInstructionAsync({
      user: createNoopSigner(USER),
      mint: MINT,
      tokenProgram: address(TOKEN_2022_PROGRAM),
      amount: 1_000_000n,
      destination: null,
    });
    expect(ix.accounts[3]?.address).toBe(TOKEN_2022_PROGRAM);
    expect(ix.accounts[2]?.address).toBe(await expectedAta(TOKEN_2022_PROGRAM));
    expect(ix.accounts[2]?.address).not.toBe(await expectedAta(CLASSIC_TOKEN_PROGRAM));
  });

  it("encodes destination as an option (present vs omitted change the data length)", async () => {
    const withNone = await buildWithdraw(null);
    const withSome = await buildWithdraw(DESTINATION);
    // discriminator(1) + amount(8) + option prefix(1) [+ 32 when Some].
    expect(withNone.data?.length).toBe(10);
    expect(withSome.data?.length).toBe(42);
  });
});
