/**
 * Fingerprint determinism for the keyed DvP create.
 *
 * The fingerprint is what makes an Idempotency-Key a proof rather than a claim:
 * a key reused with different terms must mismatch. These tests pin the material
 * that goes in and the properties that must survive — determinism, the
 * null-vs-"" distinction, and that a party slot's reference kind AND resolved
 * address are both material.
 */

import { type Address, address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import type { CreateDvpTradeInput, DvpPartyInput } from "./create";
import { dvpCreateFingerprint, type ResolvedParty } from "./fingerprint";

const ADDR_A: Address = address("7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg");
const ADDR_A_OTHER: Address = address("GjupWG8a4BXmduuUQt7vP7QxJ5Kq5YhwKZNkFYp5KPr");
const ADDR_B: Address = address("EdBvwdvCVfNRsKk6F6g5TthdN3Ci8jQgrxTGpCwAHjux");
const MINT_A: Address = address("ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1");
const MINT_B: Address = address("AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE");
const TOKEN_A: Address = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const TOKEN_B: Address = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

function baseInput(
  partyA: DvpPartyInput,
  partyB: DvpPartyInput,
  payerWalletId: string | null
): CreateDvpTradeInput {
  return {
    organizationId: "org_x",
    projectId: "prj_x",
    partyA,
    partyB,
    payerWalletId,
    mintA: MINT_A,
    tokenProgramA: TOKEN_A,
    mintB: MINT_B,
    tokenProgramB: TOKEN_B,
    amountA: 1000n,
    amountB: 2000n,
    expiryTimestamp: 1_000_000n,
    earliestSettlementTimestamp: null,
    refString: null,
    userASettlementDestination: null,
    userBSettlementDestination: null,
    idempotencyKey: null,
  };
}

function resolved(addr: Address, counterpartyAccountId: string | null): ResolvedParty {
  return { address: addr, counterpartyAccountId };
}

describe("dvpCreateFingerprint", () => {
  it("is deterministic: the same input hashes the same", () => {
    const input = baseInput({ address: ADDR_A }, { address: ADDR_B }, null);
    const a = dvpCreateFingerprint({
      input,
      resolvedA: resolved(ADDR_A, null),
      resolvedB: resolved(ADDR_B, null),
    });
    const b = dvpCreateFingerprint({
      input,
      resolvedA: resolved(ADDR_A, null),
      resolvedB: resolved(ADDR_B, null),
    });
    expect(a).toBe(b);
  });

  it("keeps null and the empty string distinct (payerWalletId)", () => {
    const addrInput = baseInput({ address: ADDR_A }, { address: ADDR_B }, null);
    const strInput = baseInput({ address: ADDR_A }, { address: ADDR_B }, "");
    // "" is not a valid wallet id in practice, but the point is that the
    // encoding distinguishes the two rather than collapsing them.
    const a = dvpCreateFingerprint({
      input: addrInput,
      resolvedA: resolved(ADDR_A, null),
      resolvedB: resolved(ADDR_B, null),
    });
    const b = dvpCreateFingerprint({
      input: strInput,
      resolvedA: resolved(ADDR_A, null),
      resolvedB: resolved(ADDR_B, null),
    });
    expect(a).not.toBe(b);
  });

  it("treats the party slot reference kind as material (address vs walletId-resolving-to-the-same-address)", () => {
    const asAddress = baseInput({ address: ADDR_A }, { address: ADDR_B }, null);
    const asWallet = baseInput({ walletId: "wal_x" }, { address: ADDR_B }, null);
    const a = dvpCreateFingerprint({
      input: asAddress,
      resolvedA: resolved(ADDR_A, null),
      resolvedB: resolved(ADDR_B, null),
    });
    const b = dvpCreateFingerprint({
      input: asWallet,
      resolvedA: resolved(ADDR_A, null),
      resolvedB: resolved(ADDR_B, null),
    });
    expect(a).not.toBe(b);
  });

  it("treats the party slot reference value as material (same kind, different id)", () => {
    const cpa1 = baseInput({ counterpartyAccountId: "cpa_1" }, { address: ADDR_B }, null);
    const cpa2 = baseInput({ counterpartyAccountId: "cpa_2" }, { address: ADDR_B }, null);
    const a = dvpCreateFingerprint({
      input: cpa1,
      resolvedA: resolved(ADDR_A, "cpa_1"),
      resolvedB: resolved(ADDR_B, null),
    });
    const b = dvpCreateFingerprint({
      input: cpa2,
      resolvedA: resolved(ADDR_A, "cpa_2"),
      resolvedB: resolved(ADDR_B, null),
    });
    expect(a).not.toBe(b);
  });

  it("treats the resolved address as material (same reference id, re-pointed address)", () => {
    const input = baseInput({ counterpartyAccountId: "cpa_1" }, { address: ADDR_B }, null);
    const before = dvpCreateFingerprint({
      input,
      resolvedA: resolved(ADDR_A, "cpa_1"),
      resolvedB: resolved(ADDR_B, null),
    });
    const after = dvpCreateFingerprint({
      input,
      resolvedA: resolved(ADDR_A_OTHER, "cpa_1"),
      resolvedB: resolved(ADDR_B, null),
    });
    expect(before).not.toBe(after);
  });

  it("treats payerWalletId as material when sent", () => {
    const noPayer = baseInput({ address: ADDR_A }, { address: ADDR_B }, null);
    const withPayer = baseInput({ address: ADDR_A }, { address: ADDR_B }, "wal_payer");
    const a = dvpCreateFingerprint({
      input: noPayer,
      resolvedA: resolved(ADDR_A, null),
      resolvedB: resolved(ADDR_B, null),
    });
    const b = dvpCreateFingerprint({
      input: withPayer,
      resolvedA: resolved(ADDR_A, null),
      resolvedB: resolved(ADDR_B, null),
    });
    expect(a).not.toBe(b);
  });

  it("treats amounts and mints as material", () => {
    const base = baseInput({ address: ADDR_A }, { address: ADDR_B }, null);
    const diffAmount = { ...base, amountA: 999n };
    const diffMint = { ...base, mintB: MINT_A };
    const fp = dvpCreateFingerprint({
      input: base,
      resolvedA: resolved(ADDR_A, null),
      resolvedB: resolved(ADDR_B, null),
    });
    const fpAmount = dvpCreateFingerprint({
      input: diffAmount,
      resolvedA: resolved(ADDR_A, null),
      resolvedB: resolved(ADDR_B, null),
    });
    const fpMint = dvpCreateFingerprint({
      input: diffMint,
      resolvedA: resolved(ADDR_A, null),
      resolvedB: resolved(ADDR_B, null),
    });
    expect(fp).not.toBe(fpAmount);
    expect(fp).not.toBe(fpMint);
  });
});
