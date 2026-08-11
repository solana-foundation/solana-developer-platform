import { type Address, address, createNoopSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  DEPOSIT_DISCRIMINATOR,
  findEventAuthorityPda,
  getDepositInstructionAsync,
  PRIVATE_CHANNEL_ESCROW_PROGRAM_ADDRESS,
} from "./index";

// Real deployed devnet escrow program + sandbox instance + devnet USDC.
const ESCROW_PROGRAM = "9tgHa1DcnaSSUtmMsst8ovKTe1Gfxzezn27KnH9xXYeU";
const INSTANCE = address("7C1Pu8mbHaDDTFnGH8YTqemNDofqXP3XEotzSo6TbwHz");
const MINT = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const PAYER = address("J231K9UEpS4y4KAPwGc4gsMNCjKFRMYcQBcjVW7vBhVi");
const USER = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const CLASSIC_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

async function buildDeposit(recipient: Address | null = null, tokenProgram?: string) {
  return getDepositInstructionAsync({
    payer: createNoopSigner(PAYER),
    user: createNoopSigner(USER),
    instance: INSTANCE,
    mint: MINT,
    amount: 1_000_000n,
    recipient,
    ...(tokenProgram ? { tokenProgram: address(tokenProgram) } : {}),
  });
}

describe("escrow deposit instruction", () => {
  it("targets the REAL deployed program (9tgHa1…), not the IDL placeholder", async () => {
    expect(PRIVATE_CHANNEL_ESCROW_PROGRAM_ADDRESS).toBe(ESCROW_PROGRAM);
    const ix = await buildDeposit();
    expect(ix.programAddress).toBe(ESCROW_PROGRAM);
  });

  it("has 12 ordered accounts and the deposit discriminator (6) as the first data byte", async () => {
    const ix = await buildDeposit();
    expect(ix.accounts).toHaveLength(12);
    expect(DEPOSIT_DISCRIMINATOR).toBe(6);
    expect(ix.data?.[0]).toBe(6);
  });

  it("derives eventAuthority + escrow-program accounts under the real program", async () => {
    const [eventAuthority] = await findEventAuthorityPda();
    const ix = await buildDeposit();
    // Account order: payer,user,instance,mint,allowedMint,userAta,instanceAta,
    // systemProgram,tokenProgram,associatedTokenProgram,eventAuthority,escrowProgram.
    expect(ix.accounts[10]?.address).toBe(eventAuthority);
    expect(ix.accounts[11]?.address).toBe(ESCROW_PROGRAM);
    expect(ix.accounts[8]?.address).toBe(CLASSIC_TOKEN_PROGRAM);
  });

  it("passing the classic program explicitly matches leaving it defaulted", async () => {
    // The deposit path now always passes `tokenProgram` rather than relying on the
    // generated default. This is the guard that threading it did not move the
    // userAta/instanceAta a working classic-USDC deposit transfers between.
    const defaulted = await buildDeposit();
    const explicit = await buildDeposit(null, CLASSIC_TOKEN_PROGRAM);
    expect(explicit.accounts.map((account) => account.address)).toEqual(
      defaulted.accounts.map((account) => account.address)
    );
    expect(explicit.data).toEqual(defaulted.data);
  });

  it("re-derives userAta and instanceAta under token-2022 when given that program", async () => {
    // `tokenProgram` is an ATA seed, so the two programs produce DIFFERENT accounts
    // for the same (owner, mint) — a hardcoded classic assumption would deposit
    // into an address the mint's real accounts have nothing to do with.
    const classic = await buildDeposit(null, CLASSIC_TOKEN_PROGRAM);
    const token2022 = await buildDeposit(null, TOKEN_2022_PROGRAM);
    expect(token2022.accounts[8]?.address).toBe(TOKEN_2022_PROGRAM);
    // userAta is index 5, instanceAta index 6 (see the account order above).
    expect(token2022.accounts[5]?.address).not.toBe(classic.accounts[5]?.address);
    expect(token2022.accounts[6]?.address).not.toBe(classic.accounts[6]?.address);
  });

  it("encodes recipient as an option (present vs omitted change the data length)", async () => {
    const withNone = await buildDeposit(null);
    const withSome = await buildDeposit(INSTANCE);
    // discriminator(1) + amount(8) + option prefix(1) [+ 32 when Some].
    expect(withNone.data?.length).toBe(10);
    expect(withSome.data?.length).toBe(42);
  });
});
