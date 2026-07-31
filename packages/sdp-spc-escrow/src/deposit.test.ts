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

async function buildDeposit(recipient: Address | null = null) {
  return getDepositInstructionAsync({
    payer: createNoopSigner(PAYER),
    user: createNoopSigner(USER),
    instance: INSTANCE,
    mint: MINT,
    amount: 1_000_000n,
    recipient,
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
    expect(ix.accounts[8]?.address).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  });

  it("encodes recipient as an option (present vs omitted change the data length)", async () => {
    const withNone = await buildDeposit(null);
    const withSome = await buildDeposit(INSTANCE);
    // discriminator(1) + amount(8) + option prefix(1) [+ 32 when Some].
    expect(withNone.data?.length).toBe(10);
    expect(withSome.data?.length).toBe(42);
  });
});
