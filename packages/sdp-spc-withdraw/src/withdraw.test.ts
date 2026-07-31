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
    const { getProgramDerivedAddress, getAddressEncoder } = await import("@solana/kit");
    const [ata] = await getProgramDerivedAddress({
      programAddress: address(ATA_PROGRAM),
      seeds: [
        getAddressEncoder().encode(USER),
        getAddressEncoder().encode(address(CLASSIC_TOKEN_PROGRAM)),
        getAddressEncoder().encode(MINT),
      ],
    });
    const ix = await buildWithdraw();
    expect(ix.accounts[2]?.address).toBe(ata);
  });

  it("encodes destination as an option (present vs omitted change the data length)", async () => {
    const withNone = await buildWithdraw(null);
    const withSome = await buildWithdraw(DESTINATION);
    // discriminator(1) + amount(8) + option prefix(1) [+ 32 when Some].
    expect(withNone.data?.length).toBe(10);
    expect(withSome.data?.length).toBe(42);
  });
});
