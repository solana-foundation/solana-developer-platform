import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, address, type Instruction } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  allowedUserAccountForDeposit,
  prefundOwnerRentInstruction,
  VEDA_ALLOWED_USER_ACCOUNT_SIZE,
  VEDA_DEPOSIT_ALLOWED_USER_ACCOUNT_INDEX,
  VEDA_DEPOSIT_DISCRIMINATOR,
} from "./allowed-user";

const VAULT_PROGRAM = address("5J76xGGXn5op9S48pMqWV6Ex48ZxsKsRs4bGeDzSHEVc");
const OWNER = address("11111111111111111111111111111112");
const SPONSOR = address("SysvarRecentB1ockHashes11111111111111111111");
const ALLOWED_USER = address("SysvarRent111111111111111111111111111111111");
const SYSTEM = "11111111111111111111111111111111";

/** A deposit-shaped instruction: right discriminator, allowed_user in place. */
function depositInstruction(overrides?: {
  programAddress?: Address;
  data?: Uint8Array;
  accountCount?: number;
}): Instruction {
  const count = overrides?.accountCount ?? 20;
  const accounts = Array.from({ length: count }, (_, index) => ({
    address: index === VEDA_DEPOSIT_ALLOWED_USER_ACCOUNT_INDEX ? ALLOWED_USER : OWNER,
    role: index === 0 ? 3 : 1,
  }));
  return {
    programAddress: overrides?.programAddress ?? VAULT_PROGRAM,
    accounts,
    data: overrides?.data ?? new Uint8Array([...VEDA_DEPOSIT_DISCRIMINATOR, 7, 7, 7]),
  } as Instruction;
}

/**
 * The constants are ABI claims about the deployed program; the committed IDL
 * is what makes them falsifiable (same pattern as `idl-layout.test.ts`). If
 * Veda ships a new IDL, these fail before a build misreads an account or
 * under-funds a prefund.
 */
describe("the committed IDL pins the deposit ABI constants", () => {
  const idlPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "idl",
    "boring_vault_svm.json"
  );
  const idl = JSON.parse(readFileSync(idlPath, "utf8")) as {
    instructions: { name: string; discriminator: number[]; accounts: { name: string }[] }[];
    types: { name: string; type: { kind: string; fields?: { name: string; type: unknown }[] } }[];
  };
  const deposit = idl.instructions.find((instruction) => instruction.name === "deposit");

  it("matches the deposit discriminator", () => {
    expect(deposit?.discriminator).toEqual([...VEDA_DEPOSIT_DISCRIMINATOR]);
  });

  it("finds allowed_user at the pinned account index", () => {
    expect(deposit?.accounts[VEDA_DEPOSIT_ALLOWED_USER_ACCOUNT_INDEX]?.name).toBe("allowed_user");
  });

  it("recomputes the AllowedUser account size from the IDL's own fields", () => {
    const sizes: Record<string, number> = { bool: 1, u8: 1, u64: 8, i64: 8, pubkey: 32 };
    const struct = idl.types.find((type) => type.name === "AllowedUser");
    const fields = struct?.type.fields ?? [];
    expect(fields.length).toBeGreaterThan(0);
    const size = fields.reduce((total, field) => {
      const fieldSize = sizes[String(field.type)];
      if (fieldSize === undefined) throw new Error(`unsized AllowedUser field ${field.name}`);
      return total + fieldSize;
    }, 8); // the 8-byte Anchor account discriminator
    expect(size).toBe(VEDA_ALLOWED_USER_ACCOUNT_SIZE);
  });
});

describe("allowedUserAccountForDeposit", () => {
  it("reads the allowed_user account off the deposit instruction", () => {
    expect(allowedUserAccountForDeposit([depositInstruction()], VAULT_PROGRAM)).toBe(ALLOWED_USER);
  });

  it("ignores instructions of other programs and other discriminators", () => {
    expect(
      allowedUserAccountForDeposit(
        [depositInstruction({ programAddress: address(SYSTEM) })],
        VAULT_PROGRAM
      )
    ).toBeUndefined();
    expect(
      allowedUserAccountForDeposit(
        [depositInstruction({ data: new Uint8Array([183, 18, 70, 156, 148, 109, 161, 34]) })],
        VAULT_PROGRAM
      )
    ).toBeUndefined();
    expect(
      allowedUserAccountForDeposit([depositInstruction({ data: new Uint8Array() })], VAULT_PROGRAM)
    ).toBeUndefined();
  });

  it("returns undefined when the account table is shorter than the pinned index", () => {
    expect(
      allowedUserAccountForDeposit(
        [depositInstruction({ accountCount: VEDA_DEPOSIT_ALLOWED_USER_ACCOUNT_INDEX })],
        VAULT_PROGRAM
      )
    ).toBeUndefined();
  });
});

describe("prefundOwnerRentInstruction", () => {
  it("encodes one System transfer from the sponsor to the owner", () => {
    const instruction = prefundOwnerRentInstruction(SPONSOR, OWNER, 1_171_605n);
    expect(String(instruction.programAddress)).toBe(SYSTEM);
    expect(instruction.accounts?.[0]).toMatchObject({ address: SPONSOR, role: 3 });
    expect(instruction.accounts?.[1]).toMatchObject({ address: OWNER, role: 1 });

    const data = instruction.data as Uint8Array;
    expect(data).toHaveLength(12);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    expect(view.getUint32(0, true)).toBe(2); // System Transfer
    expect(view.getBigUint64(4, true)).toBe(1_171_605n);
  });
});
