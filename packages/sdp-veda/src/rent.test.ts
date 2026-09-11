import { type Address, address, type Instruction } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS } from "./programs";
import { chargeAtaCreationRentTo, createdAtaAddressForMint, isAtaCreateInstruction } from "./rent";

const OWNER = address("11111111111111111111111111111112");
const SPONSOR = address("SysvarRecentB1ockHashes11111111111111111111");
const SHARE_MINT = address("So11111111111111111111111111111111111111112");
const DEPOSIT_MINT = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const SHARE_ATA = address("SysvarRent111111111111111111111111111111111");
const VAULT_ATA = address("SysvarC1ock11111111111111111111111111111111");
const VAULT_HOLDER = address("Stake11111111111111111111111111111111111111");
const SYSTEM = address("11111111111111111111111111111111");
const TOKEN_2022 = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const VAULT_PROGRAM = address("5J76xGGXn5op9S48pMqWV6Ex48ZxsKsRs4bGeDzSHEVc");

function ataCreate(input: {
  payer: Address;
  ata: Address;
  wallet: Address;
  mint: Address;
  data?: Uint8Array;
}): Instruction {
  return {
    programAddress: address(ASSOCIATED_TOKEN_PROGRAM_ADDRESS),
    accounts: [
      { address: input.payer, role: 3 },
      { address: input.ata, role: 1 },
      { address: input.wallet, role: 0 },
      { address: input.mint, role: 0 },
      { address: SYSTEM, role: 0 },
      { address: TOKEN_2022, role: 0 },
    ],
    // CreateIdempotent unless the test says otherwise.
    data: input.data ?? new Uint8Array([1]),
  } as Instruction;
}

const depositInstruction: Instruction = {
  programAddress: VAULT_PROGRAM,
  accounts: [
    { address: OWNER, role: 3 },
    { address: SHARE_ATA, role: 1 },
  ],
  data: new Uint8Array([9, 9, 9]),
} as Instruction;

describe("isAtaCreateInstruction", () => {
  it("recognises Create ([], [0]) and CreateIdempotent ([1])", () => {
    const base = ataCreate({ payer: OWNER, ata: SHARE_ATA, wallet: OWNER, mint: SHARE_MINT });
    expect(isAtaCreateInstruction(base)).toBe(true);
    expect(isAtaCreateInstruction({ ...base, data: new Uint8Array([0]) })).toBe(true);
    expect(isAtaCreateInstruction({ ...base, data: new Uint8Array() })).toBe(true);
  });

  it("refuses RecoverNested — its index 0 is not a funding payer", () => {
    const recover = ataCreate({
      payer: OWNER,
      ata: SHARE_ATA,
      wallet: OWNER,
      mint: SHARE_MINT,
      data: new Uint8Array([2]),
    });
    expect(isAtaCreateInstruction(recover)).toBe(false);
  });

  it("refuses other programs and short account lists", () => {
    expect(isAtaCreateInstruction(depositInstruction)).toBe(false);
    const short = ataCreate({ payer: OWNER, ata: SHARE_ATA, wallet: OWNER, mint: SHARE_MINT });
    expect(
      isAtaCreateInstruction({ ...short, accounts: short.accounts?.slice(0, 3) } as Instruction)
    ).toBe(false);
  });
});

describe("chargeAtaCreationRentTo", () => {
  const instructions: readonly Instruction[] = [
    ataCreate({ payer: OWNER, ata: SHARE_ATA, wallet: OWNER, mint: SHARE_MINT }),
    ataCreate({ payer: OWNER, ata: VAULT_ATA, wallet: VAULT_HOLDER, mint: DEPOSIT_MINT }),
    depositInstruction,
  ];

  it("swaps ONLY the funding payer on the ATA creates, preserving role, order and count", () => {
    const charged = chargeAtaCreationRentTo(instructions, SPONSOR);

    expect(charged).toHaveLength(3);
    expect(charged[0]?.accounts?.[0]).toEqual({ address: SPONSOR, role: 3 });
    expect(charged[1]?.accounts?.[0]).toEqual({ address: SPONSOR, role: 3 });
    // Every other account survives verbatim.
    expect(charged[0]?.accounts?.slice(1)).toEqual(instructions[0]?.accounts?.slice(1));
    expect(charged[1]?.accounts?.slice(1)).toEqual(instructions[1]?.accounts?.slice(1));
    // The deposit instruction is not the ATA program's and is untouched.
    expect(charged[2]).toBe(depositInstruction);
  });

  it("leaves a create already funded by the rent payer untouched", () => {
    const alreadySponsored = [
      ataCreate({ payer: SPONSOR, ata: SHARE_ATA, wallet: OWNER, mint: SHARE_MINT }),
    ];
    const charged = chargeAtaCreationRentTo(alreadySponsored, SPONSOR);
    expect(charged[0]).toBe(alreadySponsored[0]);
  });

  it("never rewrites RecoverNested", () => {
    const recover = ataCreate({
      payer: OWNER,
      ata: SHARE_ATA,
      wallet: OWNER,
      mint: SHARE_MINT,
      data: new Uint8Array([2]),
    });
    expect(chargeAtaCreationRentTo([recover], SPONSOR)[0]).toBe(recover);
  });
});

describe("createdAtaAddressForMint", () => {
  const instructions: readonly Instruction[] = [
    ataCreate({ payer: OWNER, ata: SHARE_ATA, wallet: OWNER, mint: SHARE_MINT }),
    ataCreate({ payer: OWNER, ata: VAULT_ATA, wallet: VAULT_HOLDER, mint: DEPOSIT_MINT }),
    depositInstruction,
  ];

  it("returns the created account for the requested mint", () => {
    expect(createdAtaAddressForMint(instructions, SHARE_MINT)).toBe(SHARE_ATA);
    expect(createdAtaAddressForMint(instructions, DEPOSIT_MINT)).toBe(VAULT_ATA);
  });

  it("returns undefined when the plan creates no account for the mint", () => {
    expect(createdAtaAddressForMint([depositInstruction], SHARE_MINT)).toBeUndefined();
    expect(createdAtaAddressForMint(instructions, TOKEN_2022)).toBeUndefined();
  });
});
